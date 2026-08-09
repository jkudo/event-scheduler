const { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, provide, inject } = Vue;

const app = createApp({
    setup() {
        const API = '';
        const DEFAULT_SESSION_CATS = [
            { key: 'general', label: '一般' },
            { key: 'workshop', label: 'ワークショップ' }, { key: 'keynote', label: '基調講演' },
            { key: 'keynote_multi', label: '基調講演（複数人）' },
            { key: 'panel', label: 'パネルディスカッション' }, { key: 'lt', label: 'LT' },
        ];
        const MULTI_SPEAKER_CATS = ['lt', 'panel', 'keynote_multi'];
        function isMultiSpeakerCat(cat) {
            if (MULTI_SPEAKER_CATS.includes(cat)) return true;
            // 追加した形式は multi フラグで判定する
            const c = extraSessionCats.value.find(c => c.key === cat);
            return !!(c && c.multi);
        }
        // 複数登壇者UIの表示ラベル（形式ごとに呼称が異なる）
        const SPEAKER_LABELS = {
            lt: { list: 'LT登壇者一覧', add: 'LT登壇者を追加', rep: '司会者' },
            panel: { list: 'パネリスト一覧', add: 'パネリストを追加', rep: 'モデレーター' },
            keynote_multi: { list: '登壇者一覧', add: '登壇者を追加', rep: '代表登壇者' },
        };
        function speakerLabel(cat, kind) {
            return (SPEAKER_LABELS[cat] || SPEAKER_LABELS.lt)[kind];
        }
        const extraSessionCats = ref([]);
        const sessionCatOptions = computed(() => [...DEFAULT_SESSION_CATS, ...extraSessionCats.value]);
        const customRoles = ref([]);
        const categoryRoleLinks = ref({});
        const groupRoleLinks = ref({});
        const STATIC_LABELS = { session: 'セッション', overall: '全体', tech: '技術' }; // tech: 廃止済み形式の既存データ用ラベル
        const SLOT_MIN = 5; // 5分刻み

        const tab = ref('realtime');
        // スタッフ絞り込みは端末に記憶する
        const RT_FILTER_KEY = 'cs_rt_staff_filter';
        const realtimeStaffFilter = ref(parseInt(localStorage.getItem(RT_FILTER_KEY), 10) || 0);
        watch(realtimeStaffFilter, v => {
            if (v) localStorage.setItem(RT_FILTER_KEY, String(v));
            else localStorage.removeItem(RT_FILTER_KEY);
        });
        const sidebarOpen = ref(false);

        // --- ログインロール（管理者 / 閲覧用） ---
        const myRole = ref('admin');
        const isViewer = computed(() => myRole.value === 'viewer');
        const VIEWER_TABS = ['all-matrix', 'realtime', 'staff-detail', 'venue-view', 'my-profile', 'help'];

        // --- サイドバーの見出しの開閉（端末に記憶する） ---
        const NAV_SECTIONS = ['event', 'assign', 'system'];
        const navOpen = reactive({ event: true, assign: true, system: true });
        try {
            const saved = JSON.parse(localStorage.getItem('cs_nav_open') || '{}');
            NAV_SECTIONS.forEach(k => { if (typeof saved[k] === 'boolean') navOpen[k] = saved[k]; });
        } catch (e) { /* 壊れていれば既定値のまま */ }
        function toggleNavSection(key) {
            navOpen[key] = !navOpen[key];
            localStorage.setItem('cs_nav_open', JSON.stringify({ ...navOpen }));
        }
        // タブがどの見出しに属するかを返す
        function navSectionOf(name) {
            if (['overall-manage', 'staffs', 'rooms', 'venue-maps'].includes(name)) return 'event';
            if (['overall-assign', 'algorithm'].includes(name)) return 'assign';
            if (['settings', 'auto-backup', 'io', 'public-api'].includes(name)) return 'system';
            if (/^grp-\d+-manage$/.test(name)) return 'event';
            if (/^grp-\d+-assign$/.test(name)) return 'assign';
            if (categories.value.some(c => c.key + '-manage' === name)) return 'event';
            if (categories.value.some(c => c.key === name)) return 'assign';
            return null;
        }
        const myStaffId = ref(parseInt(localStorage.getItem('cs_my_staff_id'), 10) || null);
        const myProfileSelect = ref(0);
        async function loadMe() {
            try {
                const data = await fetch(API + '/auth/me').then(r => r.json());
                myRole.value = data.role || 'admin';
            } catch (e) { myRole.value = 'admin'; }
            if (isViewer.value && !VIEWER_TABS.includes(tab.value)) tab.value = 'realtime';
        }
        const rooms = ref([]);
        const OVERALL_ROOM_NAME = '全体';
        // 「全体」部屋を除いた選択可能な部屋（通常のセッション用）
        const selectableRooms = computed(() => rooms.value.filter(r => r.name !== OVERALL_ROOM_NAME));
        const overallRoomId = computed(() => {
            const r = rooms.value.find(r => r.name === OVERALL_ROOM_NAME);
            return r ? r.id : null;
        });
        const sessions = ref([]);
        const staffs = ref([]);
        const schedule = ref([]);
        const staffAssignments = ref([]);
        const scheduleMsg = ref(null);
        const scheduleMsgError = ref('');
        const sessPhotoPreview = ref('');
        const sessPhoto = ref(null);
        const matrixStaffFilter = ref(0);
        const staffDetailFilter = ref('');
        const staffDetailStaffId = ref(0);   // 0 = 全員
        const staffListStaffId = ref(0);     // スタッフ管理の一覧絞り込み。0 = 全員
        const filteredStaffs = computed(() =>
            staffListStaffId.value ? staffs.value.filter(s => s.id === staffListStaffId.value) : staffs.value);
        // 絞り込みで編集中のカードが消えると編集フォームも追加フォームも出なくなるため、編集を解除する
        watch(staffListStaffId, () => { if (staffForm.editId) cancelEditStaff(); });
        function staffDetailMatch(staff) {
            // スタッフ名での絞り込み
            if (staffDetailStaffId.value && staff.id !== staffDetailStaffId.value) return false;
            const f = staffDetailFilter.value;
            if (!f) return true;
            const roles = Array.isArray(staff.role) ? staff.role : (staff.role ? staff.role.split(',') : []);
            if (f === 'none') return !roles.length;
            return roles.includes(f);
        }
        // 絞り込み後の件数（該当なしの案内に使う）
        const staffDetailCount = computed(() =>
            staffAssignmentsForDetail.value.filter(e => staffDetailMatch(e.staff)).length);

        let dragDidMove = false; // suppress click after drag-and-drop
        const matrixLocked = ref(true); // ドラッグ&ドロップのロック（デフォルト: ロック）

        // --- 動的カテゴリ ---
        const categories = ref([]);
        const categoryLocks = reactive({});
        const categoryForms = reactive({});
        const categoryAssignMsgs = reactive({});
        const categoryStaffFilters = reactive({});
        const catGroupTabs = reactive({});
        const catSelectedSessions = reactive({});

        async function loadCategories() {
            categories.value = await (await fetch(API + '/api/categories/')).json();
            categories.value.forEach(c => {
                if (!(c.key in categoryLocks)) categoryLocks[c.key] = true;
                if (!(c.key in categoryForms)) categoryForms[c.key] = { editId: null, title: '', start_time: '', end_time: '', room_id: null, required_staff: 2, english_required: false, notes: '' };
                if (!(c.key in categoryAssignMsgs)) categoryAssignMsgs[c.key] = '';
                if (!(c.key in categoryStaffFilters)) categoryStaffFilters[c.key] = 0;
                const ckDates = catKeyDates(c.key);
                if (!(c.key in catGroupTabs)) catGroupTabs[c.key] = 0;
                if (!(c.key in catSelectedSessions)) catSelectedSessions[c.key] = new Set();
            });
            if (!catSettingForm.editId) catSettingForm.order = nextCatOrder();
        }
        const dynamicCatKeys = computed(() => categories.value.map(c => c.key));
        const CATEGORY_LABELS = computed(() => {
            const m = { ...STATIC_LABELS };
            sessionCatOptions.value.forEach(c => { m[c.key] = c.label; });
            categories.value.forEach(c => { m[c.key] = c.label; });
            customRoles.value.forEach(r => { m[r.key] = r.label; });
            return m;
        });
        const roleOptions = computed(() => {
            const opts = [{ v: 'session', l: 'セッション' }];
            categories.value.forEach(c => opts.push({ v: c.key, l: c.label }));
            customRoles.value.forEach(r => opts.push({ v: r.key, l: r.label }));
            return opts;
        });

        // --- 動的セッショングループ ---
        const sessionGroups = ref([]);
        const groupLocks = reactive({});
        const groupSessForms = reactive({});
        const groupStaffFilters = reactive({});
        const groupScheduleMsgs = reactive({});
        const groupSelectedSessions = reactive({});
        const grpDateTabs = reactive({});

        async function loadSessionGroups() {
            sessionGroups.value = await (await fetch(API + '/api/session-groups/')).json();
            sessionGroups.value.forEach(g => {
                if (!(g.id in groupLocks)) groupLocks[g.id] = true;
                if (!(g.id in groupSessForms)) {
                    groupSessForms[g.id] = {
                        editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
                        room_id: null, category: 'general', required_staff: 0, english_required: false,
                        description: '', notes: '', currentPhoto: '', photoFile: null, photoPreview: '',
                        speaker_org: '', speaker_title: '', speaker_profile: '',
                        _ltTalks: reactive([])
                    };
                } else if (!('photoPreview' in groupSessForms[g.id])) {
                    groupSessForms[g.id].photoPreview = '';
                }
                if (!(g.id in groupStaffFilters)) groupStaffFilters[g.id] = 0;
                if (!(g.id in groupScheduleMsgs)) groupScheduleMsgs[g.id] = '';
                if (!(g.id in groupSelectedSessions)) groupSelectedSessions[g.id] = new Set();
            });
            if (!grpSettingForm.editId) grpSettingForm.order = nextGrpOrder();
            // allGroupTabのデフォルトはloadSessions後に設定
        }

        const roomForm = reactive({ editId: null, name: '', capacity: null, floor: 1 });
        const venueMaps = ref([]);
        const sessDetailSession = ref(null);
        const gridMenu = reactive({ show: false, x: 0, y: 0, entry: null, type: '', key: '' });
        function showGridMenu(ev, entry, type, key) {
            if (dragDidMove) return;
            // 閲覧用ログインは編集メニューを出さず詳細のみ表示
            if (isViewer.value) { toggleSessionDetail(entry.session.id); return; }
            ev.stopPropagation();
            gridMenu.show = true;
            const menuW = 140, menuH = 140;
            gridMenu.x = Math.min(ev.clientX, window.innerWidth - menuW);
            gridMenu.y = Math.min(ev.clientY, window.innerHeight - menuH);
            gridMenu.entry = entry;
            gridMenu.type = type;
            gridMenu.key = key;
        }
        function gridMenuEdit() {
            const s = gridMenu.entry.session;
            if (gridMenu.type === 'overall') editAllEntry(s);
            else if (gridMenu.type === 'grp') editGroupSession(gridMenu.key, s);
            else if (gridMenu.type === 'cat') editCategory(gridMenu.key, s);
            gridMenu.show = false;
        }
        function gridMenuDelete() {
            const s = gridMenu.entry.session;
            if (gridMenu.type === 'overall') deleteAllEntry(s.id, 'overall');
            else if (gridMenu.type === 'grp') deleteGroupSession(gridMenu.key, s.id);
            else if (gridMenu.type === 'cat') deleteCategory(gridMenu.key, s.id);
            gridMenu.show = false;
        }
        function gridMenuDetail() {
            toggleSessionDetail(gridMenu.entry.session.id);
            gridMenu.show = false;
        }
        const sessDetailEntry = computed(() => {
            if (!sessDetailSession.value) return null;
            return schedule.value.find(e => e.session.id === sessDetailSession.value.id) || null;
        });
        const sessDetailLocked = computed(() => {
            if (!sessDetailSession.value) return true;
            // 閲覧用ログインは常に読み取り専用
            if (isViewer.value) return true;
            // スケジュール（閲覧専用）から開いた詳細は常に読み取り専用
            if (tab.value === 'all-matrix') return true;
            const cat = sessDetailSession.value.category;
            if (cat in categoryLocks) return categoryLocks[cat];
            const gid = sessDetailSession.value.group_id;
            if (gid && gid in groupLocks) return groupLocks[gid];
            return matrixLocked.value;
        });
        const venueMapForm = reactive({ editId: null, title: '', order: 0, currentImage: '' });
        const venueMapPreview = ref('');
        const venueMapFile = ref(null);
        const venueMapInput = ref(null);
        const mapModal = ref(null);
        const sessForm = reactive({
            editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
            room_id: null, category: 'general', required_staff: 0, english_required: false, description: '', notes: '', currentPhoto: '',
            speaker_org: '', speaker_title: '', speaker_profile: '', group_id: null
        });
        const ltTalks = reactive([]);
        const staffForm = reactive({ editId: null, name: '', slack_name: '', emergency_contact: '', role: [], experience_count: 0, english_ok: false, currentPhoto: '' });
        const roleDropdownOpen = ref(false);
        const newStaffPhotoFile = ref(null);
        const staffPhotoPreview = ref('');
        const prefForms = reactive({});
        const availForms = reactive({});

        // --- ユーティリティ ---
        function autoSetEndTime(form) {
            if (form.start_time && !form.end_time) {
                const d = new Date(form.start_time);
                d.setMinutes(d.getMinutes() + 5);
                form.end_time = toLocalInput(d);
            }
        }
        function catLabel(cat) { return CATEGORY_LABELS.value[cat] || cat; }
        function fmt(dt) {
            return new Date(dt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }
        function fmtShort(dt) {
            return new Date(dt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        }
        function sortedPrefs(prefs) { return [...prefs].sort((a, b) => a.priority - b.priority); }
        // 全日程表示のときに一覧を日付ごとに分ける
        function _splitByDate(items, getStart) {
            const map = new Map();
            items.forEach(it => {
                const d = String(getStart(it) || '').slice(0, 10);
                if (!map.has(d)) map.set(d, []);
                map.get(d).push(it);
            });
            return [...map.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([date, list]) => ({ date, items: list }));
        }
        // 配置表エントリ（e.session を持つ）用
        function entriesByDate(entries) { return _splitByDate(entries || [], e => e.session.start_time); }
        // セッションそのもの用
        function sessionsByDate(list) { return _splitByDate(list || [], s => s.start_time); }
        function toLocalInput(dt) {
            const d = new Date(dt);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        // --- API ---
        async function loadRooms() { rooms.value = await (await fetch(API + '/api/rooms/')).json(); }
        async function loadVenueMaps() { venueMaps.value = await (await fetch(API + '/api/venue-maps/')).json(); }
        async function loadSessions() {
            sessions.value = await (await fetch(API + '/api/sessions/')).json();
        }
        async function loadStaffs() {
            const data = await (await fetch(API + '/api/staffs/')).json();
            staffs.value = data;
            data.forEach(s => {
                if (!prefForms[s.id]) prefForms[s.id] = { session_id: null };
                if (!availForms[s.id]) availForms[s.id] = { start: '', end: '' };
            });
            // 削除されたスタッフを指したままだと一覧が空になるため絞り込みを解除する
            const gone = id => id && !data.some(s => s.id === id);
            if (gone(realtimeStaffFilter.value)) realtimeStaffFilter.value = 0;
            if (gone(staffListStaffId.value)) staffListStaffId.value = 0;
            if (gone(staffDetailStaffId.value)) staffDetailStaffId.value = 0;
        }
        async function loadSchedule() {
            schedule.value = ((await (await fetch(API + '/api/assignments/schedule')).json()).schedule || []);
            // 未設定だとプルダウンが空白になるので「＋追加」を初期選択にしておく
            schedule.value.forEach(e => {
                if (assignStaffSelect[e.session.id] === undefined) assignStaffSelect[e.session.id] = 0;
            });
            // 詳細ポップアップのセッションを最新データに更新
            if (sessDetailSession.value) {
                const entry = schedule.value.find(e => e.session.id === sessDetailSession.value.id);
                if (entry) sessDetailSession.value = entry.session;
            }
        }
        async function loadStaffAssignments() {
            staffAssignments.value = ((await (await fetch(API + '/api/assignments/staff-schedule')).json()).staff_assignments || []);
        }
        // スタッフ別詳細は個人の担当を見る画面なので、全員共通の全体スケジュールは載せない
        const staffAssignmentsForDetail = computed(() =>
            staffAssignments.value.map(e => {
                const own = e.assigned_sessions.filter(s => s.category !== 'overall');
                return own.length === e.assigned_sessions.length ? e : { ...e, assigned_sessions: own };
            }));

        function exportExcel() {
            window.open(API + '/api/export/excel', '_blank');
        }
        function exportBackup() {
            window.open(API + '/api/export/backup', '_blank');
        }

        const backupFile = ref(null);
        const backupFileName = ref('');
        const ioMsg = ref('');
        const ioMsgError = ref(false);
        // スタッフ・セッションのインポート
        const staffImportFile = ref(null);
        const staffImportFileName = ref('');
        const staffImpMsg = ref('');
        const staffImpMsgError = ref(false);
        const sessionImportFile = ref(null);
        const sessionImportFileName = ref('');
        const sessImpMsg = ref('');
        const sessImpMsgError = ref(false);
        const importResult = ref(null);
        const importResultOpen = ref(false);
        const resetMsg = ref('');
        const resetMsgError = ref(false);
        const resetPassword = ref('');
        const resetPwForm = reactive({ current: '', newPw: '' });
        const resetPwMsg = ref('');
        const resetPwMsgError = ref(false);

        // --- Settings ---
        const appTitle = ref('');
        const appIcon = ref('');
        const appIconFile = ref(null);
        const appIconPreview = ref('');
        const appIconMsg = ref('');
        const allowOverlap = ref(false);
        const travelBufferMin = ref(10);
        const settingsForm = reactive({ app_title: '', allow_overlap: false, travel_buffer_minutes: 10, timezone: 'Asia/Tokyo' });
        const settingsMsg = ref('');
        const pwForm = reactive({ current: '', newPw: '' });
        const pwMsg = ref('');
        const pwMsgError = ref(false);
        // 閲覧用パスワード
        const viewerPwForm = reactive({ password: '' });
        const viewerPwSet = ref(false);
        const dbType = ref('');   // 接続中のデータベース種別（設定画面に表示）
        const viewerPwMsg = ref('');
        const viewerPwMsgError = ref(false);
        async function saveViewerPassword() {
            viewerPwMsg.value = ''; viewerPwMsgError.value = false;
            if (!viewerPwForm.password) return;
            try {
                const resp = await fetch(API + '/api/settings/viewer-password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: viewerPwForm.password })
                });
                const data = await resp.json();
                if (!resp.ok) { viewerPwMsg.value = data.detail || '設定に失敗しました'; viewerPwMsgError.value = true; return; }
                viewerPwSet.value = data.viewer_password_set === '1';
                viewerPwForm.password = '';
                viewerPwMsg.value = data.message || '設定しました';
            } catch (e) { viewerPwMsg.value = '通信エラー'; viewerPwMsgError.value = true; }
        }
        async function clearViewerPassword() {
            if (!confirm('閲覧用パスワードを削除しますか？\n閲覧用ログインは無効になります。')) return;
            viewerPwMsg.value = ''; viewerPwMsgError.value = false;
            try {
                const resp = await fetch(API + '/api/settings/viewer-password', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: '' })
                });
                const data = await resp.json();
                if (!resp.ok) { viewerPwMsg.value = data.detail || '削除に失敗しました'; viewerPwMsgError.value = true; return; }
                viewerPwSet.value = false;
                viewerPwForm.password = '';
                viewerPwMsg.value = data.message || '削除しました';
            } catch (e) { viewerPwMsg.value = '通信エラー'; viewerPwMsgError.value = true; }
        }

        async function loadSettings() {
            try {
                const data = await fetch(API + '/api/settings/').then(r => r.json());
                if (data.app_title) {
                    appTitle.value = data.app_title;
                    settingsForm.app_title = data.app_title;
                    document.title = data.app_title;
                }
                appIcon.value = data.app_icon || '';
                applyFavicon();
                allowOverlap.value = data.allow_overlap === '1';
                viewerPwSet.value = data.viewer_password_set === '1';
                dbType.value = data.database || '';
                settingsForm.allow_overlap = data.allow_overlap === '1';
                const tb = parseInt(data.travel_buffer_minutes, 10);
                travelBufferMin.value = Number.isFinite(tb) ? tb : 10;
                settingsForm.travel_buffer_minutes = travelBufferMin.value;
                if (data.timezone) settingsForm.timezone = data.timezone;
                if (data.session_categories) {
                    try { extraSessionCats.value = JSON.parse(data.session_categories); } catch (e) { extraSessionCats.value = []; }
                }
                if (data.custom_roles) {
                    try { customRoles.value = JSON.parse(data.custom_roles); } catch (e) { customRoles.value = []; }
                }
                if (data.category_role_links) {
                    try { categoryRoleLinks.value = JSON.parse(data.category_role_links) || {}; } catch (e) { categoryRoleLinks.value = {}; }
                }
                if (data.group_role_links) {
                    try { groupRoleLinks.value = JSON.parse(data.group_role_links) || {}; } catch (e) { groupRoleLinks.value = {}; }
                }
            } catch (e) { /* ignore */ }
        }
        // 登録したアイコンをブラウザタブのアイコンにも反映する
        function applyFavicon() {
            let link = document.querySelector("link[rel='icon']");
            if (!appIcon.value) {
                if (link) link.remove();
                return;
            }
            if (!link) {
                link = document.createElement('link');
                link.rel = 'icon';
                document.head.appendChild(link);
            }
            link.href = appIcon.value;
        }
        function onAppIconChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            appIconFile.value = file;
            appIconPreview.value = URL.createObjectURL(file);
            appIconMsg.value = '';
        }
        // 設定画面でも Ctrl+V で画像を貼り付けられるようにする
        function onAppIconPaste(e) {
            const items = (e.clipboardData || window.clipboardData).items;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        appIconFile.value = file;
                        appIconPreview.value = URL.createObjectURL(file);
                        appIconMsg.value = '';
                    }
                    return;
                }
            }
        }
        async function saveAppIcon() {
            if (!appIconFile.value) { appIconMsg.value = '画像を選択してください'; return; }
            const fd = new FormData();
            fd.append('icon', appIconFile.value);
            const res = await fetch(API + '/api/settings/icon', { method: 'POST', body: fd });
            if (!res.ok) { appIconMsg.value = 'アイコンの登録に失敗しました: ' + await _errText(res); return; }
            const data = await res.json();
            appIcon.value = data.app_icon;
            appIconFile.value = null;
            appIconPreview.value = '';
            appIconMsg.value = 'アイコンを登録しました';
            applyFavicon();
        }
        async function deleteAppIcon() {
            if (!confirm('アイコンを削除します。よろしいですか？')) return;
            const res = await fetch(API + '/api/settings/icon', { method: 'DELETE' });
            if (!res.ok) { appIconMsg.value = 'アイコンの削除に失敗しました'; return; }
            appIcon.value = '';
            appIconFile.value = null;
            appIconPreview.value = '';
            appIconMsg.value = 'アイコンを削除しました';
            applyFavicon();
        }
        function clearAppIconSelection() {
            appIconFile.value = null;
            appIconPreview.value = '';
            appIconMsg.value = '';
        }

        async function saveSettings() {
            settingsMsg.value = '';
            try {
                await fetch(API + '/api/settings/', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        app_title: settingsForm.app_title,
                        allow_overlap: settingsForm.allow_overlap ? '1' : '0',
                        travel_buffer_minutes: String(Math.max(0, parseInt(settingsForm.travel_buffer_minutes, 10) || 0)),
                        timezone: settingsForm.timezone
                    })
                });
                appTitle.value = settingsForm.app_title;
                document.title = settingsForm.app_title;
                allowOverlap.value = settingsForm.allow_overlap;
                travelBufferMin.value = Math.max(0, parseInt(settingsForm.travel_buffer_minutes, 10) || 0);
                settingsMsg.value = '保存しました';
            } catch (e) { settingsMsg.value = '保存に失敗しました'; }
        }

        // --- セッション形式管理 ---
        const sessCatForm = reactive({ label: '', multi: false, editIdx: null });
        const sessCatMsg = ref('');
        function editSessCat(idx) {
            const c = extraSessionCats.value[idx];
            sessCatForm.label = c.label; sessCatForm.multi = !!c.multi; sessCatForm.editIdx = idx;
        }
        function cancelSessCat() {
            sessCatForm.label = ''; sessCatForm.multi = false; sessCatForm.editIdx = null;
        }
        function _genCatKey() {
            return 'cat_' + Date.now().toString(36);
        }
        async function saveSessCat() {
            if (!sessCatForm.label) { sessCatMsg.value = '表示名を入力してください'; return; }
            const list = [...extraSessionCats.value];
            if (sessCatForm.editIdx !== null) {
                list[sessCatForm.editIdx] = { key: list[sessCatForm.editIdx].key, label: sessCatForm.label, multi: sessCatForm.multi };
            } else {
                list.push({ key: _genCatKey(), label: sessCatForm.label, multi: sessCatForm.multi });
            }
            try {
                await fetch(API + '/api/settings/', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_categories: JSON.stringify(list) })
                });
                extraSessionCats.value = list;
                cancelSessCat();
                sessCatMsg.value = '保存しました';
            } catch (e) { sessCatMsg.value = '保存に失敗しました'; }
        }
        async function deleteSessCat(idx) {
            const target = extraSessionCats.value[idx];
            if (!target) return;
            const used = sessions.value.filter(s => s.category === target.key).length;
            const msg = used
                ? `この形式を削除しますか？\n${used}件のセッションは「一般」に変更されます。`
                : 'この形式を削除しますか？';
            if (!confirm(msg)) return;
            try {
                const resp = await fetch(API + '/api/settings/session-categories/delete', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: target.key })
                });
                if (!resp.ok) { sessCatMsg.value = '削除に失敗しました'; return; }
                const data = await resp.json();
                extraSessionCats.value = data.session_categories || [];
                // 編集中インデックスは削除で前詰めされるため調整する
                if (sessCatForm.editIdx !== null) {
                    if (sessCatForm.editIdx === idx) cancelSessCat();
                    else if (sessCatForm.editIdx > idx) sessCatForm.editIdx -= 1;
                }
                if (data.moved_sessions) {
                    await loadSessions();
                    await loadSchedule();
                    sessCatMsg.value = `削除しました（${data.moved_sessions}件のセッションを一般に変更）`;
                } else {
                    sessCatMsg.value = '削除しました';
                }
            } catch (e) { sessCatMsg.value = '削除に失敗しました'; }
        }

        // --- 担当管理 ---
        const roleSettingForm = reactive({ label: '', editIdx: null });
        const roleSettingMsg = ref('');
        function editRoleSetting(idx) {
            const r = customRoles.value[idx];
            roleSettingForm.label = r.label; roleSettingForm.editIdx = idx;
        }
        function cancelRoleSetting() {
            roleSettingForm.label = ''; roleSettingForm.editIdx = null;
        }
        function _genRoleKey() {
            return 'role_' + Date.now().toString(36);
        }
        async function saveRoleSetting() {
            if (!roleSettingForm.label) { roleSettingMsg.value = '表示名を入力してください'; return; }
            const list = [...customRoles.value];
            if (roleSettingForm.editIdx !== null) {
                list[roleSettingForm.editIdx] = { key: list[roleSettingForm.editIdx].key, label: roleSettingForm.label };
            } else {
                list.push({ key: _genRoleKey(), label: roleSettingForm.label });
            }
            try {
                await fetch(API + '/api/settings/', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ custom_roles: JSON.stringify(list) })
                });
                customRoles.value = list;
                cancelRoleSetting();
                roleSettingMsg.value = '保存しました';
            } catch (e) { roleSettingMsg.value = '保存に失敗しました'; }
        }
        async function deleteRoleSetting(idx) {
            if (!confirm('この担当を削除しますか？')) return;
            const removedKey = customRoles.value[idx].key;
            const list = customRoles.value.filter((_, i) => i !== idx);
            // カテゴリ・グループへの紐づけからも削除
            function _stripKey(src) {
                const links = {};
                let changed = false;
                Object.entries(src).forEach(([k, keys]) => {
                    const filtered = keys.filter(x => x !== removedKey);
                    if (filtered.length !== keys.length) changed = true;
                    if (filtered.length) links[k] = filtered;
                });
                return { links, changed };
            }
            const cat = _stripKey(categoryRoleLinks.value);
            const grp = _stripKey(groupRoleLinks.value);
            try {
                const body = { custom_roles: JSON.stringify(list) };
                if (cat.changed) body.category_role_links = JSON.stringify(cat.links);
                if (grp.changed) body.group_role_links = JSON.stringify(grp.links);
                await fetch(API + '/api/settings/', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                customRoles.value = list;
                if (cat.changed) categoryRoleLinks.value = cat.links;
                if (grp.changed) groupRoleLinks.value = grp.links;
                // 編集中インデックスは削除で前詰めされるため調整する
                if (roleSettingForm.editIdx !== null) {
                    if (roleSettingForm.editIdx === idx) cancelRoleSetting();
                    else if (roleSettingForm.editIdx > idx) roleSettingForm.editIdx -= 1;
                }
                roleSettingMsg.value = '削除しました';
            } catch (e) { roleSettingMsg.value = '削除に失敗しました'; }
        }

        // --- カテゴリと担当の紐づけ ---
        const catRoleLinkSelect = reactive({});
        async function _saveCatRoleLinks(links) {
            await fetch(API + '/api/settings/', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_role_links: JSON.stringify(links) })
            });
            categoryRoleLinks.value = links;
        }
        async function addCatRoleLink(catKey) {
            const roleKey = catRoleLinkSelect[catKey];
            if (!roleKey) return;
            const links = { ...categoryRoleLinks.value };
            const cur = links[catKey] ? [...links[catKey]] : [];
            if (!cur.includes(roleKey)) cur.push(roleKey);
            links[catKey] = cur;
            try { await _saveCatRoleLinks(links); } catch (e) { /* ignore */ }
            catRoleLinkSelect[catKey] = '';
        }
        async function removeCatRoleLink(catKey, roleKey) {
            const links = { ...categoryRoleLinks.value };
            links[catKey] = (links[catKey] || []).filter(k => k !== roleKey);
            if (!links[catKey].length) delete links[catKey];
            try { await _saveCatRoleLinks(links); } catch (e) { /* ignore */ }
        }

        // --- セッショングループと担当の紐づけ ---
        const grpRoleLinkSelect = reactive({});
        async function _saveGrpRoleLinks(links) {
            await fetch(API + '/api/settings/', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ group_role_links: JSON.stringify(links) })
            });
            groupRoleLinks.value = links;
        }
        async function addGrpRoleLink(gid) {
            const roleKey = grpRoleLinkSelect[gid];
            if (!roleKey) return;
            const links = { ...groupRoleLinks.value };
            const cur = links[gid] ? [...links[gid]] : [];
            if (!cur.includes(roleKey)) cur.push(roleKey);
            links[gid] = cur;
            try { await _saveGrpRoleLinks(links); } catch (e) { /* ignore */ }
            grpRoleLinkSelect[gid] = '';
        }
        async function removeGrpRoleLink(gid, roleKey) {
            const links = { ...groupRoleLinks.value };
            links[gid] = (links[gid] || []).filter(k => k !== roleKey);
            if (!links[gid].length) delete links[gid];
            try { await _saveGrpRoleLinks(links); } catch (e) { /* ignore */ }
        }

        async function changePassword() {
            pwMsg.value = ''; pwMsgError.value = false;
            try {
                const resp = await fetch(API + '/api/settings/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ current_password: pwForm.current, new_password: pwForm.newPw })
                });
                const data = await resp.json();
                if (resp.ok) {
                    pwMsg.value = data.message || 'パスワードを変更しました';
                    pwMsgError.value = false;
                    pwForm.current = ''; pwForm.newPw = '';
                } else {
                    pwMsg.value = data.detail || 'パスワード変更に失敗しました';
                    pwMsgError.value = true;
                }
            } catch (e) {
                pwMsg.value = '通信エラー'; pwMsgError.value = true;
            }
        }
        // --- カテゴリ設定管理 ---
        function nextCatOrder() { return categories.value.length ? Math.max(...categories.value.map(c => c.order)) + 1 : 1; }
        const catSettingForm = reactive({ editId: null, key: '', label: '', color: '#607d8b', order: 1 });
        const catSettingMsg = ref('');
        function editCatSetting(cat) {
            catSettingForm.editId = cat.id;
            catSettingForm.key = cat.key;
            catSettingForm.label = cat.label;
            catSettingForm.color = cat.color;
            catSettingForm.order = cat.order;
            catSettingMsg.value = '';
        }
        function cancelCatSetting() {
            catSettingForm.editId = null;
            catSettingForm.key = '';
            catSettingForm.label = '';
            catSettingForm.color = '#607d8b';
            catSettingForm.order = nextCatOrder();
            catSettingMsg.value = '';
        }
        async function saveCatSetting() {
            if (!catSettingForm.label) { catSettingMsg.value = '表示名は必須です'; return; }
            const payload = { label: catSettingForm.label, color: catSettingForm.color, order: catSettingForm.order };
            if (catSettingForm.editId && catSettingForm.key) payload.key = catSettingForm.key;
            try {
                let resp;
                if (catSettingForm.editId) {
                    resp = await fetch(API + '/api/categories/' + catSettingForm.editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                } else {
                    resp = await fetch(API + '/api/categories/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                }
                if (resp.ok) {
                    catSettingMsg.value = catSettingForm.editId ? '更新しました' : '追加しました';
                    cancelCatSetting();
                    await loadCategories();
                } else {
                    const data = await resp.json();
                    catSettingMsg.value = data.detail || 'エラーが発生しました';
                }
            } catch (e) { catSettingMsg.value = '通信エラー'; }
        }
        async function deleteCatSetting(id) {
            if (!confirm('このカテゴリを削除しますか？\n※ セッションが登録されている場合は削除できません。')) return;
            try {
                const resp = await fetch(API + '/api/categories/' + id, { method: 'DELETE' });
                if (resp.ok) {
                    catSettingMsg.value = '削除しました';
                    await loadCategories();
                } else {
                    const data = await resp.json();
                    catSettingMsg.value = data.detail || '削除に失敗しました';
                }
            } catch (e) { catSettingMsg.value = '通信エラー'; }
        }

        // --- セッショングループ設定管理 ---
        function nextGrpOrder() { return sessionGroups.value.length ? Math.max(...sessionGroups.value.map(g => g.order)) + 1 : 1; }
        const grpSettingForm = reactive({ editId: null, label: '', date: '', order: 1, color: '#1a73e8' });
        const grpSettingMsg = ref('');
        function editGrpSetting(grp) {
            grpSettingForm.editId = grp.id;
            grpSettingForm.label = grp.label;
            grpSettingForm.date = grp.date;
            grpSettingForm.order = grp.order;
            grpSettingForm.color = grp.color;
            grpSettingMsg.value = '';
        }
        function cancelGrpSetting() {
            grpSettingForm.editId = null;
            grpSettingForm.label = '';
            grpSettingForm.date = '';
            grpSettingForm.order = nextGrpOrder();
            grpSettingForm.color = '#1a73e8';
            grpSettingMsg.value = '';
        }
        async function saveGrpSetting() {
            if (!grpSettingForm.label) { grpSettingMsg.value = '表示名は必須です'; return; }
            const payload = { label: grpSettingForm.label, date: grpSettingForm.date, order: grpSettingForm.order, color: grpSettingForm.color };
            try {
                let resp;
                if (grpSettingForm.editId) {
                    resp = await fetch(API + '/api/session-groups/' + grpSettingForm.editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                } else {
                    resp = await fetch(API + '/api/session-groups/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                }
                if (resp.ok) {
                    grpSettingMsg.value = grpSettingForm.editId ? '更新しました' : '追加しました';
                    cancelGrpSetting();
                    await loadSessionGroups();
                } else {
                    const data = await resp.json();
                    grpSettingMsg.value = data.detail || 'エラーが発生しました';
                }
            } catch (e) { grpSettingMsg.value = '通信エラー'; }
        }
        async function deleteGrpSetting(id) {
            if (!confirm('このセッショングループを削除しますか？\n※ グループ内のセッションと配置情報もすべて削除されます。')) return;
            try {
                const resp = await fetch(API + '/api/session-groups/' + id, { method: 'DELETE' });
                if (resp.ok) {
                    grpSettingMsg.value = '削除しました';
                    await loadSessionGroups();
                } else {
                    const data = await resp.json();
                    grpSettingMsg.value = data.detail || '削除に失敗しました';
                }
            } catch (e) { grpSettingMsg.value = '通信エラー'; }
        }

        function onBackupFileChange(e) {
            const f = e.target.files[0];
            if (f) { backupFile.value = f; backupFileName.value = f.name; }
            ioMsg.value = '';
        }
        async function importBackup() {
            if (!backupFile.value) return;
            if (!confirm('現在の全データが削除され、バックアップの内容で上書きされます。\nこの操作は取り消せません。よろしいですか？')) return;
            ioMsg.value = 'インポート中...';
            ioMsgError.value = false;
            const fd = new FormData();
            fd.append('file', backupFile.value);
            try {
                const res = await fetch(API + '/api/export/restore', { method: 'POST', body: fd });
                let data;
                try { data = await res.json(); } catch { data = { detail: 'サーバーエラー (HTTP ' + res.status + ')' }; }
                if (res.ok) {
                    ioMsg.value = `インポート完了: 部屋 ${data.rooms}件, セッション ${data.sessions}件, スタッフ ${data.staffs}件, 配置 ${data.assignments}件`;
                    ioMsgError.value = false;
                    backupFile.value = null;
                    backupFileName.value = '';
                    await loadSessionGroups(); await loadCategories(); await loadRooms(); await loadSessions(); await loadStaffs(); await loadSchedule(); await loadStaffAssignments(); loadVenueMaps(); loadSettings();
                } else {
                    ioMsg.value = data.detail || 'インポートに失敗しました';
                    ioMsgError.value = true;
                }
            } catch (e) {
                ioMsg.value = 'インポートに失敗しました: ' + e.message;
                ioMsgError.value = true;
            }
        }
        function onStaffImportFileChange(e) {
            const f = e.target.files[0];
            if (f) { staffImportFile.value = f; staffImportFileName.value = f.name; }
            staffImpMsg.value = '';
        }
        function onSessionImportFileChange(e) {
            const f = e.target.files[0];
            if (f) { sessionImportFile.value = f; sessionImportFileName.value = f.name; }
            sessImpMsg.value = '';
        }
        async function _postImport(path, file) {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch(API + path, { method: 'POST', body: fd });
            let data;
            try { data = await res.json(); } catch { data = { detail: 'サーバーエラー (HTTP ' + res.status + ')' }; }
            return { ok: res.ok, data };
        }
        function _importSummary(d) {
            return `登録 ${d.created}件 / スキップ ${d.skipped.length}件 / エラー ${d.errors.length}件`;
        }
        async function importStaffs() {
            if (!staffImportFile.value) return;
            staffImpMsg.value = 'インポート中...';
            staffImpMsgError.value = false;
            importResult.value = null;
            try {
                const { ok, data } = await _postImport('/api/export/import-staffs', staffImportFile.value);
                if (!ok) {
                    staffImpMsg.value = data.detail || 'インポートに失敗しました';
                    staffImpMsgError.value = true;
                    return;
                }
                staffImpMsg.value = _importSummary(data);
                importResult.value = { kind: 'スタッフ', ...data };
                if (data.skipped.length || data.errors.length) importResultOpen.value = true;
                staffImportFile.value = null;
                staffImportFileName.value = '';
                await loadStaffs();
            } catch (e) {
                staffImpMsg.value = 'インポートに失敗しました: ' + e.message;
                staffImpMsgError.value = true;
            }
        }
        async function importSessions() {
            if (!sessionImportFile.value) return;
            sessImpMsg.value = 'インポート中...';
            sessImpMsgError.value = false;
            importResult.value = null;
            try {
                const { ok, data } = await _postImport('/api/export/import-sessions', sessionImportFile.value);
                if (!ok) {
                    sessImpMsg.value = data.detail || 'インポートに失敗しました';
                    sessImpMsgError.value = true;
                    return;
                }
                sessImpMsg.value = _importSummary(data);
                if (data.created_rooms.length) sessImpMsg.value += ` / 部屋を自動作成 ${data.created_rooms.length}件`;
                if (data.created_groups.length) sessImpMsg.value += ` / グループを自動作成 ${data.created_groups.length}件`;
                importResult.value = { kind: 'セッション', ...data };
                if (data.skipped.length || data.errors.length) importResultOpen.value = true;
                sessionImportFile.value = null;
                sessionImportFileName.value = '';
                await loadRooms(); await loadSessionGroups(); await loadSessions(); await loadSchedule();
            } catch (e) {
                sessImpMsg.value = 'インポートに失敗しました: ' + e.message;
                sessImpMsgError.value = true;
            }
        }

        async function resetAllData() {
            if (!resetPassword.value) return;
            if (!confirm('すべてのデータを完全に削除します。\nこの操作は取り消せません。\n\n本当に初期化しますか？')) return;
            if (!confirm('最終確認: 部屋、セッション、スタッフ、配置、会場地図、画像がすべて削除されます。\n本当によろしいですか？')) return;
            resetMsg.value = '初期化中...';
            resetMsgError.value = false;
            try {
                const res = await fetch(API + '/api/export/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: resetPassword.value })
                });
                let data;
                try { data = await res.json(); } catch { data = { detail: 'サーバーエラー (HTTP ' + res.status + ')' }; }
                if (res.ok) {
                    resetMsg.value = data.message || '全データを初期化しました';
                    resetMsgError.value = false;
                    resetPassword.value = '';
                    await loadSessionGroups(); await loadCategories(); await loadRooms(); await loadSessions(); await loadStaffs(); await loadSchedule(); await loadStaffAssignments(); loadVenueMaps(); loadSettings();
                } else {
                    resetMsg.value = data.detail || '初期化に失敗しました';
                    resetMsgError.value = true;
                }
            } catch (e) {
                resetMsg.value = '初期化に失敗しました: ' + e.message;
                resetMsgError.value = true;
            }
        }

        async function changeResetPassword() {
            if (!resetPwForm.current || !resetPwForm.newPw) return;
            resetPwMsg.value = '';
            try {
                const res = await fetch(API + '/api/export/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ current_password: resetPwForm.current, new_password: resetPwForm.newPw })
                });
                const data = await res.json();
                if (res.ok) {
                    resetPwMsg.value = data.message || '変更しました';
                    resetPwMsgError.value = false;
                    resetPwForm.current = ''; resetPwForm.newPw = '';
                } else {
                    resetPwMsg.value = data.detail || '変更に失敗しました';
                    resetPwMsgError.value = true;
                }
            } catch (e) {
                resetPwMsg.value = '変更に失敗しました: ' + e.message;
                resetPwMsgError.value = true;
            }
        }

        // --- Auto Backup ---
        const abSettings = reactive({ enabled: false, schedule_type: 'interval', interval_minutes: 720, daily_time: '03:00', retention_count: 28 });
        const abStatus = reactive({ running: false, last_run: null, last_status: null, next_run: null, error: null });
        const abHistory = ref([]);
        const abMsg = ref('');
        const abDownload = ref(false);
        async function loadAbSettings() {
            try {
                const data = await fetch(API + '/api/backup/auto/settings').then(r => r.json());
                Object.assign(abSettings, data);
            } catch (e) { /* ignore */ }
        }
        async function loadAbStatus() {
            try {
                const data = await fetch(API + '/api/backup/auto/status').then(r => r.json());
                Object.assign(abStatus, data);
            } catch (e) { /* ignore */ }
        }
        async function loadAbHistory() {
            try {
                abHistory.value = await fetch(API + '/api/backup/auto/history').then(r => r.json());
            } catch (e) { /* ignore */ }
        }
        async function saveAbSettings() {
            abMsg.value = '';
            try {
                await fetch(API + '/api/backup/auto/settings', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(abSettings)
                });
                abMsg.value = '設定を保存しました';
                await loadAbStatus();
            } catch (e) { abMsg.value = '保存に失敗しました'; }
        }
        async function triggerBackupNow() {
            abMsg.value = 'バックアップを実行中...';
            try {
                const res = await fetch(API + '/api/backup/auto/run', { method: 'POST' });
                if (res.ok) {
                    const result = await res.json();
                    abMsg.value = 'バックアップが完了しました';
                    await loadAbHistory();
                    await loadAbStatus();
                    if (abDownload.value && result.id) {
                        const a = document.createElement('a');
                        a.href = API + '/api/backup/auto/history/' + result.id + '/download';
                        a.download = result.filename || 'backup.zip';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    }
                } else {
                    const err = await res.json();
                    abMsg.value = 'バックアップに失敗しました: ' + (err.detail || '');
                }
            } catch (e) { abMsg.value = 'バックアップに失敗しました'; }
        }
        async function deleteBackupEntry(id) {
            if (!confirm('このバックアップを削除しますか？')) return;
            await fetch(API + '/api/backup/auto/history/' + id, { method: 'DELETE' });
            await loadAbHistory();
        }

        async function downloadBackupEntry(id, createdAt) {
            try {
                const res = await fetch(API + '/api/backup/auto/history/' + id + '/download');
                if (!res.ok) { alert('ダウンロードに失敗しました'); return; }
                const blob = await res.blob();
                const d = new Date(createdAt);
                const ts = d.getFullYear() + ('0'+(d.getMonth()+1)).slice(-2) + ('0'+d.getDate()).slice(-2) + '_' + ('0'+d.getHours()).slice(-2) + ('0'+d.getMinutes()).slice(-2) + ('0'+d.getSeconds()).slice(-2);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'backup_' + ts + '.zip';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
            } catch (e) { alert('ダウンロードに失敗しました'); }
        }

        // --- 公開API ---
        const pubApi = reactive({ enabled: false, key: '', keyMasked: '', cors_origins: '*', active_snapshot: '', webhook_url: '', github_dispatch_url: '', github_token_set: false, github_token_input: '' });
        const pubHistory = ref([]);
        const pubMsg = ref('');
        const pubMsgError = ref(false);
        function _pubMsg(msg, isError) { pubMsg.value = msg; pubMsgError.value = !!isError; }
        async function loadPubApiSettings() {
            try {
                const data = await fetch(API + '/api/public-api/settings').then(r => r.json());
                Object.assign(pubApi, data);
                pubApi.github_token_input = '';
            } catch (e) { /* ignore */ }
        }
        async function savePubApiSettings() {
            _pubMsg('');
            try {
                const res = await fetch(API + '/api/public-api/settings', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: pubApi.enabled, cors_origins: pubApi.cors_origins, webhook_url: pubApi.webhook_url, github_dispatch_url: pubApi.github_dispatch_url, github_token: pubApi.github_token_input })
                });
                const data = await res.json();
                Object.assign(pubApi, data);
                _pubMsg('設定を保存しました');
            } catch (e) { _pubMsg('保存に失敗しました', true); }
        }
        async function regenerateApiKey() {
            if (!confirm('APIキーを再生成しますか？既存のキーは無効になります。')) return;
            try {
                const data = await fetch(API + '/api/public-api/settings/regenerate-key', { method: 'POST' }).then(r => r.json());
                pubApi.key = data.key;
                pubApi.keyMasked = data.key_masked;
                _pubMsg('APIキーを再生成しました');
            } catch (e) { _pubMsg('再生成に失敗しました', true); }
        }
        async function clearGithubToken() {
            if (!confirm('GitHub Personal Access Tokenを削除しますか？')) return;
            try {
                await fetch(API + '/api/public-api/settings/clear-github-token', { method: 'POST' });
                pubApi.github_token_set = false;
                pubApi.github_token_input = '';
                _pubMsg('トークンを削除しました');
            } catch (e) { _pubMsg('削除に失敗しました', true); }
        }
        async function publishSnapshot() {
            _pubMsg('パブリッシュ中...', false);
            try {
                const res = await fetch(API + '/api/public-api/publish', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ base_url: window.location.origin })
                });
                if (res.ok) {
                    const data = await res.json();
                    pubApi.active_snapshot = data.snapshot_id;
                    await loadPubHistory();
                    let msg = 'パブリッシュしました（' + data.session_count + 'セッション）';
                    if (data.webhook) {
                        const w = data.webhook;
                        if (w.webhook) {
                            msg += w.webhook.success ? ' / Webhook送信済み' : ' / Webhook送信失敗';
                        }
                        if (w.github_dispatch) {
                            msg += w.github_dispatch.success ? ' / GitHub Actions実行済み' : ' / GitHub Actions実行失敗';
                        }
                    }
                    _pubMsg(msg);
                } else {
                    const err = await res.json();
                    _pubMsg('パブリッシュに失敗しました: ' + (err.detail || ''), true);
                }
            } catch (e) { _pubMsg('パブリッシュに失敗しました', true); }
        }
        async function loadPubHistory() {
            try {
                pubHistory.value = await fetch(API + '/api/public-api/history').then(r => r.json());
            } catch (e) { /* ignore */ }
        }
        async function activateSnapshot(id) {
            try {
                await fetch(API + '/api/public-api/activate/' + id, { method: 'POST' });
                pubApi.active_snapshot = id;
                await loadPubHistory();
                _pubMsg('スナップショットをアクティブにしました');
            } catch (e) { _pubMsg('切替に失敗しました', true); }
        }
        async function deleteSnapshot(id) {
            if (!confirm('このスナップショットを削除しますか？')) return;
            try {
                const res = await fetch(API + '/api/public-api/history/' + id, { method: 'DELETE' });
                if (!res.ok) { const err = await res.json(); _pubMsg(err.detail || '削除に失敗しました', true); return; }
                await loadPubHistory();
                _pubMsg('削除しました');
            } catch (e) { _pubMsg('削除に失敗しました', true); }
        }
        const pubApiUrl = computed(function() {
            return window.location.origin + '/public/api/schedule?key=' + pubApi.key;
        });
        function copyApiUrl() {
            var url = window.location.origin + '/public/api/schedule?key=' + pubApi.key;
            navigator.clipboard.writeText(url).then(function() { _pubMsg('URLをコピーしました'); });
        }
        function copyApiKey() {
            navigator.clipboard.writeText(pubApi.key).then(function() { _pubMsg('APIキーをコピーしました'); });
        }

        // タブを移動したらドラッグ&ドロップのロックを掛け直す
        function relockAll() {
            matrixLocked.value = true;
            overallLocked.value = true;
            Object.keys(groupLocks).forEach(k => { groupLocks[k] = true; });
            Object.keys(categoryLocks).forEach(k => { categoryLocks[k] = true; });
        }

        // タブを移動したら編集中の状態を解除する（入力途中の新規追加フォームは残す）
        function resetEditForms() {
            roleDropdownOpen.value = false;
            if (roomForm.editId) cancelEditRoom();
            if (venueMapForm.editId) cancelEditVenueMap();
            if (sessForm.editId) cancelEditSession();
            if (staffForm.editId) cancelEditStaff();
            if (allOvForm.editId) cancelAllOverall();
            Object.keys(groupSessForms).forEach(gid => {
                if (groupSessForms[gid] && groupSessForms[gid].editId) cancelEditGroupSession(gid);
            });
            Object.keys(categoryForms).forEach(k => {
                if (categoryForms[k] && categoryForms[k].editId) cancelEditCategory(k);
            });
            if (sessCatForm.editIdx !== null) cancelSessCat();
            if (roleSettingForm.editIdx !== null) cancelRoleSetting();
            if (catSettingForm.editId) cancelCatSetting();
            if (grpSettingForm.editId) cancelGrpSetting();
        }

        async function switchTab(name) {
            resetEditForms();
            relockAll();
            tab.value = name;
            sidebarOpen.value = false;
            // リアルタイム表示のタイマーはそのタブにいる間だけ動かす。
            // 読み込み中に別タブへ切り替えられても取り残さないよう、先に止めてから
            // 読み込み後に「まだそのタブか」を確認して開始する。
            stopRealtime();
            if (name === 'realtime') {
                await Promise.all([loadStaffs(), loadSessions(), loadSchedule()]);
                if (tab.value !== 'realtime') return;
                startRealtime();
            }
            // 折りたたまれた見出しの中のタブへ移動した場合は開く
            const sec = navSectionOf(name);
            if (sec && !navOpen[sec]) navOpen[sec] = true;
            if (name === 'rooms') await loadRooms();
            if (name === 'venue-maps') await loadVenueMaps();
            if (name === 'staffs') await Promise.all([loadSessions(), loadStaffs(), loadSchedule()]);
            if (name === 'my-profile') {
                await Promise.all([loadSessions(), loadStaffs(), loadSchedule()]);
                const s = staffs.value.find(x => x.id === myStaffId.value);
                if (s) editStaff(s);
                else { myStaffId.value = null; cancelEditStaff(); }
            }
            if (name === 'all-matrix') await Promise.all([loadRooms(), loadStaffs(), loadSessions(), loadSchedule()]);
            if (name === 'staff-detail') await Promise.all([loadStaffs(), loadSessions(), loadSchedule(), loadStaffAssignments()]);
            if (name === 'overall-manage') await loadSessions();
            // 動的セッショングループのタブ
            for (const g of sessionGroups.value) {
                if (name === 'grp-' + g.id + '-manage') {
                    await Promise.all([loadRooms(), loadSessions()]);
                    if (grpDateTabs[g.id] === undefined) grpDateTabs[g.id] = 0;
                    if (groupSessForms[g.id] && !groupSessForms[g.id].room_id && selectableRooms.value.length) groupSessForms[g.id].room_id = selectableRooms.value[0].id;
                    break;
                }
                if (name === 'grp-' + g.id + '-assign') {
                    await Promise.all([loadRooms(), loadStaffs(), loadSessions(), loadSchedule(), loadStaffAssignments()]);
                    if (grpDateTabs[g.id] === undefined) grpDateTabs[g.id] = 0;
                    break;
                }
            }
            // 動的カテゴリの管理・担当タブ
            for (const c of categories.value) {
                if (name === c.key + '-manage') {
                    await Promise.all([loadRooms(), loadSessions(), loadSchedule()]);
                    if (categoryForms[c.key] && !categoryForms[c.key].room_id && selectableRooms.value.length) categoryForms[c.key].room_id = selectableRooms.value[0].id;
                    break;
                }
                if (name === c.key) {
                    await Promise.all([loadRooms(), loadStaffs(), loadSessions(), loadSchedule()]);
                    if (categoryForms[c.key] && !categoryForms[c.key].room_id && selectableRooms.value.length) categoryForms[c.key].room_id = selectableRooms.value[0].id;
                    break;
                }
            }
            if (name === 'venue-view') await loadVenueMaps();
            if (name === 'io') await Promise.all([loadRooms(), loadSessions()]);
            if (name === 'auto-backup') await Promise.all([loadAbSettings(), loadAbHistory(), loadAbStatus()]);
            if (name === 'public-api') await Promise.all([loadPubApiSettings(), loadPubHistory()]);
            // セッション管理 or バックアップタブならポーリング開始
            if (name === 'auto-backup' || /^grp-\d+-manage$/.test(name)) {
                _startTabPolling();
            } else {
                _stopTabPolling();
            }
        }

        // --- タブ自動更新ポーリング ---
        let _tabPollTimer = null;
        function _startTabPolling() {
            _stopTabPolling();
            _tabPollTimer = setInterval(function() {
                var t = tab.value;
                // バックアップタブ
                if (t === 'auto-backup') {
                    var prev = abStatus.last_run;
                    loadAbStatus().then(function() {
                        if (abStatus.last_run !== prev) { loadAbHistory(); }
                    });
                    return;
                }
                // セッション管理タブ（編集中はスキップ）
                var grpMatch = t.match(/^grp-(\d+)-manage$/);
                if (grpMatch) {
                    var gid = parseInt(grpMatch[1]);
                    if (groupSessForms[gid] && groupSessForms[gid].editId) return;
                    loadSessions();
                    return;
                }
            }, 1000);
        }
        function _stopTabPolling() {
            if (_tabPollTimer != null) { clearInterval(_tabPollTimer); _tabPollTimer = null; }
        }

        // --- 部屋 ---
        function cancelEditRoom() {
            Object.assign(roomForm, { editId: null, name: '', capacity: null, floor: 1 });
        }
        function editRoom(r) {
            Object.assign(roomForm, { editId: r.id, name: r.name, capacity: r.capacity, floor: r.floor });
        }
        async function submitRoom() {
            if (!roomForm.name) { alert('未入力の項目があります: 部屋名'); return; }
            if (roomForm.name === OVERALL_ROOM_NAME) { alert('「全体」は予約済みの部屋名のため使用できません'); return; }
            const payload = { name: roomForm.name, capacity: roomForm.capacity || 0, floor: roomForm.floor };
            let res;
            if (roomForm.editId) {
                res = await fetch(API + `/api/rooms/${roomForm.editId}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                res = await fetch(API + '/api/rooms/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }
            if (!res.ok) { alert('部屋の保存に失敗しました'); return; }
            cancelEditRoom();
            await loadRooms();
        }
        async function deleteRoom(id) {
            if (!confirm('この部屋を削除しますか？')) return;
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (roomForm.editId === id) cancelEditRoom();
            const res = await fetch(API + `/api/rooms/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                alert(err.detail || '削除に失敗しました');
                return;
            }
            await loadRooms();
        }

        // --- 会場地図 ---
        function onVenueMapChange(e) {
            const file = e.target.files[0];
            // タブを移動するとinput要素が作り直されFileが失われるため、状態側に保持する
            venueMapFile.value = file || null;
            venueMapPreview.value = file ? URL.createObjectURL(file) : '';
        }
        function cancelEditVenueMap() {
            Object.assign(venueMapForm, { editId: null, title: '', order: 0, currentImage: '' });
            venueMapPreview.value = '';
            venueMapFile.value = null;
            if (venueMapInput.value) venueMapInput.value.value = '';
        }
        function editVenueMap(m) {
            Object.assign(venueMapForm, { editId: m.id, title: m.title, order: m.order, currentImage: m.image });
            venueMapPreview.value = '';
            venueMapFile.value = null;
            if (venueMapInput.value) venueMapInput.value.value = '';
        }
        async function submitVenueMap() {
            const fd = new FormData();
            fd.append('title', venueMapForm.title);
            fd.append('order', venueMapForm.order);
            if (venueMapFile.value) fd.append('image', venueMapFile.value);
            let res;
            if (venueMapForm.editId) {
                res = await fetch(API + `/api/venue-maps/${venueMapForm.editId}`, { method: 'PUT', body: fd });
            } else {
                res = await fetch(API + '/api/venue-maps/', { method: 'POST', body: fd });
            }
            if (!res.ok) { alert('会場地図の保存に失敗しました'); return; }
            cancelEditVenueMap();
            await loadVenueMaps();
        }
        async function deleteVenueMap(id) {
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (venueMapForm.editId === id) cancelEditVenueMap();
            const res = await fetch(API + `/api/venue-maps/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('会場地図の削除に失敗しました'); return; }
            await loadVenueMaps();
        }

        // --- セッション ---
        function toggleSessionDetail(id) {
            // Suppress click after drag
            if (dragDidMove) return;
            if (sessDetailSession.value && sessDetailSession.value.id === id) {
                sessDetailSession.value = null;
            } else {
                // セッション管理・配置どちらからでも検索
                let s = sessions.value.find(s => s.id === id);
                if (!s) {
                    const entry = schedule.value.find(e => e.session.id === id);
                    if (entry) s = entry.session;
                }
                sessDetailSession.value = s || null;
            }
        }
        function toggleSessDetailLock() {
            if (!sessDetailSession.value || isViewer.value) return;
            const cat = sessDetailSession.value.category;
            if (cat in categoryLocks) { categoryLocks[cat] = !categoryLocks[cat]; return; }
            const gid = sessDetailSession.value.group_id;
            if (gid && gid in groupLocks) { groupLocks[gid] = !groupLocks[gid]; return; }
            matrixLocked.value = !matrixLocked.value;
        }
        function onPhotoChange(e) {
            const file = e.target.files[0];
            sessPhotoPreview.value = file ? URL.createObjectURL(file) : '';
        }
        function onPhotoPaste(e) {
            const items = (e.clipboardData && e.clipboardData.items) || [];
            for (const item of items) {
                if (!item.type || !item.type.startsWith('image/')) continue;
                const file = item.getAsFile();
                if (!file) continue;
                const input = e.currentTarget.parentElement.querySelector('input[type=file]');
                if (!input) return;
                const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                const dt = new DataTransfer();
                dt.items.add(new File([file], file.name || `pasted_${Date.now()}.${ext}`, { type: file.type }));
                input.files = dt.files;
                input.dispatchEvent(new Event('change'));
                return;
            }
        }
        function addLTTalk(gid) {
            if (gid !== undefined) {
                if (!groupSessForms[gid]._ltTalks) groupSessForms[gid]._ltTalks = reactive([]);
                groupSessForms[gid]._ltTalks.push({ title: '', speaker: '', speaker_kana: '', speaker_org: '', speaker_title: '', speaker_photo: '', start_time: '', end_time: '', photoFile: null, photoPreview: '', is_representative: 0 });
            } else {
                ltTalks.push({ title: '', speaker: '', speaker_kana: '', speaker_org: '', speaker_title: '', speaker_photo: '', start_time: '', end_time: '', photoFile: null, photoPreview: '', is_representative: 0 });
            }
        }
        function onLTTalkPhoto(event, gidOrIdx, idx) {
            const file = event.target.files[0];
            if (!file) return;
            if (idx !== undefined) {
                // group mode: onLTTalkPhoto(event, gid, idx)
                groupSessForms[gidOrIdx]._ltTalks[idx].photoFile = file;
                groupSessForms[gidOrIdx]._ltTalks[idx].photoPreview = URL.createObjectURL(file);
            } else {
                // legacy mode: onLTTalkPhoto(event, idx)
                ltTalks[gidOrIdx].photoFile = file;
                ltTalks[gidOrIdx].photoPreview = URL.createObjectURL(file);
            }
        }
        const autoSetLTEndTime = autoSetEndTime;
        function toggleRepresentative(talks, idx) {
            const current = talks[idx].is_representative;
            talks.forEach(t => t.is_representative = 0);
            if (!current) talks[idx].is_representative = 1;
        }
        function cancelEditSession() {
            Object.assign(sessForm, {
                editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
                room_id: selectableRooms.value.length ? selectableRooms.value[0].id : null,
                category: 'general', required_staff: 0, english_required: false, description: '', notes: '', currentPhoto: '',
                speaker_org: '', speaker_title: '', speaker_profile: '', group_id: sessForm.group_id
            });
            ltTalks.splice(0);
            sessPhotoPreview.value = '';
            if (sessPhoto.value) sessPhoto.value.value = '';
        }
        function editSession(s) {
            Object.assign(sessForm, {
                editId: s.id, title: s.title, speaker: s.speaker, speaker_kana: s.speaker_kana || '',
                start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                room_id: s.room_id, category: s.category,
                required_staff: s.required_staff, english_required: !!s.english_required, description: s.description || '', notes: s.notes || '',
                currentPhoto: s.speaker_photo || '',
                speaker_org: s.speaker_org || '', speaker_title: s.speaker_title || '',
                speaker_profile: s.speaker_profile || '', group_id: s.group_id
            });
            ltTalks.splice(0);
            if (s.lt_talks && s.lt_talks.length) {
                s.lt_talks.forEach(t => ltTalks.push({
                    title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana || '',
                    speaker_org: t.speaker_org || '', speaker_title: t.speaker_title || '',
                    speaker_photo: t.speaker_photo || '', photoFile: null, photoPreview: '',
                    is_representative: t.is_representative || 0
                }));
            }
            sessPhotoPreview.value = '';
            if (sessPhoto.value) sessPhoto.value.value = '';
        }
        async function submitSession() {
            const missing = [];
            if (!sessForm.title) missing.push('セッション名');
            if (!dynamicCatKeys.value.includes(sessForm.category) && !isMultiSpeakerCat(sessForm.category) && !sessForm.speaker) missing.push('スピーカー');
            if (!sessForm.start_time) missing.push('開始時間');
            if (!sessForm.end_time) missing.push('終了時間');
            if (!sessForm.room_id) missing.push('部屋');
            if (missing.length) { alert('未入力の項目があります: ' + missing.join('、')); return; }
            const fd = new FormData();
            fd.append('title', sessForm.title);
            // LT/受付/懇親会の場合、speakerは自動設定
            if (isMultiSpeakerCat(sessForm.category) && ltTalks.length) {
                fd.append('speaker', ltTalks.map(t => t.speaker).filter(Boolean).join(', '));
            } else if (dynamicCatKeys.value.includes(sessForm.category)) {
                fd.append('speaker', '-');
            } else {
                fd.append('speaker', sessForm.speaker);
            }
            fd.append('speaker_kana', sessForm.speaker_kana);
            fd.append('speaker_org', sessForm.speaker_org);
            fd.append('speaker_title', sessForm.speaker_title);
            fd.append('speaker_profile', sessForm.speaker_profile);
            const st = sessForm.start_time; const et = sessForm.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', sessForm.room_id);
            fd.append('category', sessForm.category);
            fd.append('required_staff', sessForm.required_staff);
            fd.append('english_required', sessForm.english_required);
            fd.append('description', sessForm.description);
            fd.append('notes', sessForm.notes);
            if (sessForm.group_id) fd.append('group_id', sessForm.group_id);
            if (sessPhoto.value && sessPhoto.value.files[0]) fd.append('speaker_photo', sessPhoto.value.files[0]);

            const sessionId = await _saveSession(fd, sessForm.editId);
            if (!sessionId) return;
            if (isMultiSpeakerCat(sessForm.category) && ltTalks.length) {
                await _saveLtTalks(sessionId, ltTalks);
            }
            cancelEditSession();
            await loadSessions(); await loadSchedule();
        }
        async function deleteSession(id) {
            const res = await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('セッションの削除に失敗しました'); return; }
            await loadSessions(); await loadSchedule();
        }

        const calcStaffMsg = ref('');
        const calcStaffSummary = ref(null);
        const calcStaffOpen = ref(false);
        // ボタンから開くときは前回の結果を消してから計算する
        async function openCalcStaff() {
            calcStaffSummary.value = null;
            calcStaffMsg.value = '計算しています…';
            calcStaffOpen.value = true;
            await calcRequiredStaff();
        }
        async function calcRequiredStaff() {
            const res = await fetch(API + '/api/sessions/calc-required-staff', { method: 'POST' });
            if (!res.ok) {
                calcStaffMsg.value = '必要人数の計算に失敗しました';
                alert('必要人数の計算に失敗しました');
                return;
            }
            const data = await res.json();
            calcStaffMsg.value = data.message;
            calcStaffSummary.value = {
                min: data.min_total_staff,
                comfortable: data.comfortable_total_staff,
                total: data.total_staff,
                byRole: data.by_role || [],
            };
            await loadSessions();
        }

        // --- スタッフ ---
        // APIエラーの detail を取り出す
        async function _errText(res) {
            try {
                const d = await res.json();
                return typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
            } catch (e) {
                return `HTTP ${res.status}`;
            }
        }

        // --- 開催日の範囲（活動可能時間の入力制限に使う） ---
        function _localInput(d) {
            const p = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
        }
        const eventRange = computed(() => {
            if (!sessions.value.length) return null;
            let min = null, max = null;
            sessions.value.forEach(s => {
                const st = new Date(s.start_time), en = new Date(s.end_time);
                if (!min || st < min) min = st;
                if (!max || en > max) max = en;
            });
            if (!min || !max) return null;
            const first = new Date(min.getFullYear(), min.getMonth(), min.getDate(), 0, 0);
            const last = new Date(max.getFullYear(), max.getMonth(), max.getDate(), 23, 59);
            return { min: _localInput(first), max: _localInput(last), minDate: first, maxDate: last };
        });
        const eventRangeLabel = computed(() => {
            const r = eventRange.value;
            if (!r) return '';
            return `${r.min.slice(0, 10)} 〜 ${r.max.slice(0, 10)}`;
        });
        // 開催日の範囲内か検証する。範囲外なら理由を返し、問題なければ空文字を返す
        function checkAvailRange(startStr, endStr) {
            if (!startStr || !endStr) return '開始と終了の両方を入力してください';
            if (startStr >= endStr) return '終了は開始より後の時刻を指定してください';
            const r = eventRange.value;
            if (!r) return '';
            if (startStr < r.min || endStr > r.max) {
                return `活動可能時間は開催日の範囲内で指定してください（${eventRangeLabel.value}）`;
            }
            return '';
        }

        const editingStaffPrefs = computed(() => {
            if (!staffForm.editId) return [];
            const s = staffs.value.find(s => s.id === staffForm.editId);
            return s ? sortedPrefs(s.preferred_sessions) : [];
        });
        const editingStaffAvails = computed(() => {
            if (!staffForm.editId) return [];
            const s = staffs.value.find(s => s.id === staffForm.editId);
            return s ? s.availabilities : [];
        });

        const newStaffAvails = reactive([]);
        const newAvailForm = reactive({ start: '', end: '' });
        function addNewStaffAvail() {
            const err = checkAvailRange(newAvailForm.start, newAvailForm.end);
            if (err) { alert(err); return; }
            newStaffAvails.push({ start_time: newAvailForm.start + ':00', end_time: newAvailForm.end + ':00' });
            newAvailForm.start = '';
            newAvailForm.end = '';
        }

        const newStaffPrefs = reactive([]);
        const newPrefForm = reactive({ session_id: null });
        // 既に使われている優先度・セッションは選べないようにする
        const usedPrefPriorities = computed(() => {
            const list = staffForm.editId ? editingStaffPrefs.value : newStaffPrefs;
            return list.map(p => p.priority);
        });
        const usedPrefSessionIds = computed(() => {
            const list = staffForm.editId ? editingStaffPrefs.value : newStaffPrefs;
            return list.map(p => p.session_id);
        });
        // 次に付ける優先度。欠番があればそこを埋める
        const nextPrefPriority = computed(() => {
            const used = usedPrefPriorities.value;
            for (let i = 1; i <= used.length + 1; i++) {
                if (!used.includes(i)) return i;
            }
            return 1;
        });
        const availablePrefSessions = computed(() => {
            const used = usedPrefSessionIds.value;
            // 全体スケジュールは全員が対象なので希望には選ばせない
            return sessions.value.filter(s => s.category !== 'overall' && !used.includes(s.id));
        });
        function addNewStaffPref() {
            if (!newPrefForm.session_id) { alert('セッションを選択してください'); return; }
            if (usedPrefSessionIds.value.includes(newPrefForm.session_id)) { alert('同じセッションを複数の希望に指定できません'); return; }
            newStaffPrefs.push({ session_id: newPrefForm.session_id, priority: nextPrefPriority.value });
            newPrefForm.session_id = null;
        }
        function sessionTitle(id) {
            const s = sessions.value.find(s => s.id === id);
            return s ? s.title : 'セッション ' + id;
        }
        function sessionLabel(id) {
            const s = sessions.value.find(s => s.id === id);
            return s ? `${fmt(s.start_time)} - ${fmtShort(s.end_time)} ${s.title}` : 'セッション ' + id;
        }

        const staffAssignCount = computed(() => {
            const counts = {};
            schedule.value.forEach(e => {
                e.assigned_staff.forEach(a => {
                    counts[a.staff.id] = (counts[a.staff.id] || 0) + 1;
                });
            });
            return counts;
        });

        async function submitStaff() {
            if (!staffForm.name) { alert('未入力の項目があります: スタッフ名'); return; }
            if (staffForm.experience_count === null || staffForm.experience_count === '' || staffForm.experience_count < 0) { alert('過去参加回数を入力してください'); return; }
            let slackName = (staffForm.slack_name || '').trim();
            if (slackName && !slackName.startsWith('@')) slackName = '@' + slackName;
            const payload = { name: staffForm.name, slack_name: slackName, emergency_contact: (staffForm.emergency_contact || '').trim(), role: staffForm.role, experience_count: staffForm.experience_count, english_ok: staffForm.english_ok, max_hours: staffForm.max_hours || 8 };
            if (staffForm.editId) {
                const res = await fetch(API + `/api/staffs/${staffForm.editId}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) { const err = await res.text(); alert('スタッフの更新に失敗しました: ' + err); return; }
                if (newStaffPhotoFile.value) {
                    const fd = new FormData();
                    fd.append('photo', newStaffPhotoFile.value);
                    const resPhoto = await fetch(API + `/api/staffs/${staffForm.editId}/photo`, { method: 'POST', body: fd });
                    if (!resPhoto.ok) { alert('スタッフ写真のアップロードに失敗しました'); }
                }
            } else {
                payload.availabilities = newStaffAvails.map(a => ({ start_time: a.start_time, end_time: a.end_time }));
                payload.preferred_sessions = newStaffPrefs.map(p => ({ session_id: p.session_id, priority: p.priority }));
                const res = await fetch(API + '/api/staffs/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) { alert('スタッフの作成に失敗しました'); return; }
                const created = await res.json();
                if (newStaffPhotoFile.value) {
                    const fd = new FormData();
                    fd.append('photo', newStaffPhotoFile.value);
                    const resPhoto = await fetch(API + `/api/staffs/${created.id}/photo`, { method: 'POST', body: fd });
                    if (!resPhoto.ok) { alert('スタッフ写真のアップロードに失敗しました'); }
                }
                // マイプロフィールから新規登録した場合は自分として記憶する
                if (tab.value === 'my-profile' && created.id) {
                    myStaffId.value = created.id;
                    localStorage.setItem('cs_my_staff_id', String(created.id));
                }
            }
            await loadStaffs();
            // マイプロフィールでは自分のレコードの編集状態を維持する
            if (tab.value === 'my-profile' && myStaffId.value) {
                const s = staffs.value.find(x => x.id === myStaffId.value);
                if (s) editStaff(s); else cancelEditStaff();
            } else {
                cancelEditStaff();
            }
        }
        function selectMyStaff() {
            const s = staffs.value.find(x => x.id === myProfileSelect.value);
            if (!s) return;
            myStaffId.value = s.id;
            localStorage.setItem('cs_my_staff_id', String(s.id));
            editStaff(s);
        }
        function clearMyStaff() {
            myStaffId.value = null;
            myProfileSelect.value = 0;
            localStorage.removeItem('cs_my_staff_id');
            cancelEditStaff();
        }
        function editStaff(s) {
            staffForm.editId = s.id;
            staffForm.name = s.name;
            staffForm.slack_name = s.slack_name || '';
            staffForm.emergency_contact = s.emergency_contact || '';
            staffForm.role = Array.isArray(s.role) ? [...s.role] : (s.role ? s.role.split(',') : []);
            staffForm.experience_count = s.experience_count;
            staffForm.english_ok = !!s.english_ok;
            staffForm.currentPhoto = s.photo || '';
            newStaffPhotoFile.value = null;
            staffPhotoPreview.value = '';
            // 希望セッションの優先度は未使用の最小値を初期選択にする
            if (!prefForms[s.id]) prefForms[s.id] = { session_id: null };
            prefForms[s.id].session_id = null;
            // 一覧の該当カードまでスクロールする
            nextTick(() => {
                const el = document.getElementById('staff-edit-' + s.id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
        function cancelEditStaff() {
            Object.assign(staffForm, { editId: null, name: '', slack_name: '', emergency_contact: '', role: [], experience_count: 0, english_ok: false, currentPhoto: '' });
            clearNewStaffPhoto();
            newStaffAvails.splice(0);
            newAvailForm.start = '';
            newAvailForm.end = '';
            newStaffPrefs.splice(0);
            newPrefForm.session_id = null;
        }
        async function deleteStaff(id) {
            if (!confirm('このスタッフを削除しますか？配置情報も削除されます。')) return;
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (staffForm.editId === id) cancelEditStaff();
            const res = await fetch(API + `/api/staffs/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('スタッフの削除に失敗しました'); return; }
            await loadStaffs();
            await loadSchedule();
        }
        function onNewStaffPhoto(event) {
            const file = event.target.files[0];
            if (!file) return;
            newStaffPhotoFile.value = file;
            staffPhotoPreview.value = URL.createObjectURL(file);
        }
        function clearNewStaffPhoto() {
            newStaffPhotoFile.value = null;
            staffPhotoPreview.value = '';
        }
        async function uploadStaffPhoto(staffId, event) {
            const file = event.target.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('photo', file);
            const res = await fetch(API + `/api/staffs/${staffId}/photo`, { method: 'POST', body: fd });
            if (res.ok) {
                await loadStaffs();
                const updated = staffs.value.find(s => s.id === staffId);
                if (updated && staffForm.editId === staffId) staffForm.currentPhoto = updated.photo || '';
            } else { alert('写真のアップロードに失敗しました'); }
            event.target.value = '';
        }
        async function deleteStaffPhoto(staffId) {
            const res = await fetch(API + `/api/staffs/${staffId}/photo`, { method: 'DELETE' });
            if (!res.ok) { alert('スタッフ写真の削除に失敗しました'); return; }
            await loadStaffs();
            if (staffForm.editId === staffId) staffForm.currentPhoto = '';
        }
        async function addPref(staffId) {
            const f = prefForms[staffId];
            if (!f.session_id) { alert('セッションを選択してください'); return; }
            const priority = nextPrefPriority.value;
            const staff = staffs.value.find(s => s.id === staffId);
            const existing = staff ? staff.preferred_sessions : [];
            if (existing.some(p => p.session_id === f.session_id)) { alert('同じセッションを複数の希望に指定できません'); return; }
            const res = await fetch(API + `/api/staffs/${staffId}/preferred-sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: f.session_id, priority })
            });
            if (!res.ok) { alert('希望セッションの追加に失敗しました: ' + await _errText(res)); return; }
            f.session_id = null;
            await loadStaffs();
        }
        async function removePref(staffId, prefId) {
            const res = await fetch(API + `/api/staffs/${staffId}/preferred-sessions/${prefId}`, { method: 'DELETE' });
            if (!res.ok) { alert('希望セッションの削除に失敗しました'); return; }
            await loadStaffs();
        }
        function removeNewStaffPref(idx) {
            newStaffPrefs.splice(idx, 1);
        }
        async function addAvail(staffId) {
            const f = availForms[staffId];
            const err = checkAvailRange(f.start, f.end);
            if (err) { alert(err); return; }
            const res = await fetch(API + `/api/staffs/${staffId}/availabilities`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_time: f.start + ':00', end_time: f.end + ':00' })
            });
            if (!res.ok) { alert('活動可能時間の追加に失敗しました: ' + await _errText(res)); return; }
            f.start = '';
            f.end = '';
            await loadStaffs();
        }
        async function removeAvail(staffId, availId) {
            const res = await fetch(API + `/api/staffs/${staffId}/availabilities/${availId}`, { method: 'DELETE' });
            if (!res.ok) { alert('活動可能時間の削除に失敗しました'); return; }
            await loadStaffs();
        }

        // --- スケジュール (手動配置) ---
        const sessionSchedule = computed(() => {
            const dkeys = dynamicCatKeys.value;
            return schedule.value.filter(e => !dkeys.includes(e.session.category) && e.session.category !== 'overall');
        });
        // 動的カテゴリ別セッション
        const categorySessions = computed(() => {
            const result = {};
            categories.value.forEach(c => {
                result[c.key] = schedule.value.filter(e => e.session.category === c.key);
            });
            return result;
        });

        function _hasStaff(entry, staffId) {
            if (!staffId) return true;
            return entry.assigned_staff.some(a => a.staff.id === staffId);
        }
        // 絞り込み用。全員対象（required_staff = -1）のセッションは誰のスケジュールにも含める
        function _isStaffSession(entry, staffId) {
            if (!staffId) return true;
            if (entry.session.required_staff === -1) return true;
            return _hasStaff(entry, staffId);
        }
        const matrixStaffOptions = computed(() => staffs.value);

        const filteredMatrixSchedule = computed(() => {
            if (!matrixStaffFilter.value) return sessionSchedule.value;
            return sessionSchedule.value.filter(e => _isStaffSession(e, matrixStaffFilter.value));
        });
        // 全セッションの日付一覧を自動検出
        const catDates = computed(() => {
            const dates = new Set();
            sessions.value.forEach(s => {
                if (s.start_time) dates.add(s.start_time.slice(0, 10));
            });
            return [...dates].sort();
        });
        // 特定カテゴリのセッションがある日付のみ返す
        function catKeyDates(catKey) {
            const dates = new Set();
            sessions.value.filter(s => s.category === catKey).forEach(s => {
                if (s.start_time) dates.add(s.start_time.slice(0, 10));
            });
            return [...dates].sort();
        }
        function catGroupFiltered(catKey) {
            const sess = categorySessions.value[catKey] || [];
            const tab = catGroupTabs[catKey];
            if (!tab || tab === 0) return sess; // 全日程
            // tab = 日付文字列 or グループID
            if (typeof tab === 'string') {
                return sess.filter(e => e.session.start_time && e.session.start_time.startsWith(tab));
            }
            return sess.filter(e => e.session.group_id === tab);
        }
        function catTimelineByGroup(catKey) {
            const result = {};
            const sess = categorySessions.value[catKey] || [];
            catDates.value.forEach(date => {
                result[date] = sess
                    .filter(e => e.session.start_time && e.session.start_time.startsWith(date))
                    .sort((a, b) => new Date(a.session.start_time) - new Date(b.session.start_time));
            });
            return result;
        }
        function filteredCategorySessions(catKey) {
            const filter = categoryStaffFilters[catKey];
            const sess = catGroupFiltered(catKey);
            if (!filter) return sess;
            return sess.filter(e => _isStaffSession(e, filter));
        }
        function matrixSessionOpacity(entry) {
            if (!matrixStaffFilter.value) return 1;
            return _isStaffSession(entry, matrixStaffFilter.value) ? 1 : 0.15;
        }
        function catSessionOpacity(catKey, entry) {
            const filter = categoryStaffFilters[catKey];
            if (!filter) return 1;
            return _isStaffSession(entry, filter) ? 1 : 0.15;
        }

        const assignStaffSelect = reactive({});
        const selectedSessions = reactive(new Set());
        function toggleSessionSelect(id) {
            if (selectedSessions.has(id)) selectedSessions.delete(id);
            else selectedSessions.add(id);
        }
        function toggleSelectAll() {
            const filtered = sessionSchedule.value;
            if (selectedSessions.size === filtered.length) {
                selectedSessions.clear();
            } else {
                filtered.forEach(e => selectedSessions.add(e.session.id));
            }
        }

        function availableStaffs(entry, role) {
            const assignedIds = new Set(entry.assigned_staff.map(a => a.staff.id));
            const cat = entry.session.category;
            const targetRole = role || (cat === 'overall' ? 'overall' : (dynamicCatKeys.value.includes(cat) ? cat : 'session'));
            const sessStart = new Date(entry.session.start_time);
            const sessEnd = new Date(entry.session.end_time);
            const sessRoom = entry.session.room_id;
            const TRAVEL_MS = Math.max(0, travelBufferMin.value) * 60 * 1000; // 別部屋間の移動時間（設定値）
            // 全スケジュールからスタッフごとの割り当て済み時間帯・部屋を収集
            const staffBusyMap = {};
            for (const e of schedule.value) {
                for (const a of e.assigned_staff) {
                    if (!staffBusyMap[a.staff.id]) staffBusyMap[a.staff.id] = [];
                    staffBusyMap[a.staff.id].push({ start: new Date(e.session.start_time), end: new Date(e.session.end_time), room: e.session.room_id });
                }
            }
            return staffs.value.filter(s => {
                if (assignedIds.has(s.id)) return false;
                if (targetRole !== 'overall') {
                    const allowed = [targetRole, ...(categoryRoleLinks.value[targetRole] || [])];
                    const gid = entry.session.group_id;
                    if (gid && groupRoleLinks.value[gid]) allowed.push(...groupRoleLinks.value[gid]);
                    const roles = Array.isArray(s.role) ? s.role : (s.role || '').split(',');
                    if (!roles.some(r => allowed.includes(r))) return false;
                }
                // 時間重複・別部屋移動時間チェック（重複許可設定時はスキップ）
                if (!allowOverlap.value) {
                    const busy = staffBusyMap[s.id] || [];
                    for (const b of busy) {
                        if (sessStart < b.end && sessEnd > b.start) return false;
                        if (b.room !== sessRoom) {
                            const gap = b.end <= sessStart ? (sessStart - b.end) : (b.start - sessEnd);
                            if (gap < TRAVEL_MS) return false;
                        }
                    }
                }
                return true;
            });
        }
        async function addAssignment(sessionId) {
            const staffId = assignStaffSelect[sessionId];
            if (!staffId) return;
            const res = await fetch(API + '/api/assignments/', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: sessionId, staff_id: staffId })
            });
            if (!res.ok) {
                const err = await res.json();
                alert(err.detail || '配置に失敗しました');
                return;
            }
            assignStaffSelect[sessionId] = 0;
            await loadSchedule();
        }
        async function removeAssignment(assignmentId) {
            const res = await fetch(API + `/api/assignments/${assignmentId}`, { method: 'DELETE' });
            if (!res.ok) { alert('配置の削除に失敗しました'); return; }
            await loadSchedule();
        }
        async function setAllStaff(sessionId) {
            const res = await fetch(API + `/api/sessions/${sessionId}/required-staff`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ required_staff: -1 })
            });
            if (!res.ok) { alert('全員設定に失敗しました'); return; }
            await loadSchedule();
        }
        async function unsetAllStaff(sessionId) {
            const res = await fetch(API + `/api/sessions/${sessionId}/required-staff`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ required_staff: 0 })
            });
            if (!res.ok) { alert('全員設定の解除に失敗しました'); return; }
            await loadSchedule();
        }
        async function addAssignmentOrAll(sessionId) {
            const val = assignStaffSelect[sessionId];
            if (val === 'all') {
                await setAllStaff(sessionId);
            } else {
                const staffId = Number(val);
                if (!staffId) return;
                const res = await fetch(API + '/api/assignments/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: sessionId, staff_id: staffId })
                });
                if (!res.ok) { alert('配置の追加に失敗しました'); return; }
                await loadSchedule();
            }
            assignStaffSelect[sessionId] = 0;
        }

        // 共通: セッション保存ヘルパー
        async function _saveSession(fd, editId) {
            if (editId) {
                const res = await fetch(API + `/api/sessions/${editId}`, { method: 'PUT', body: fd });
                if (!res.ok) { const err = await res.text(); console.error('PUT error', res.status, err); alert('更新に失敗しました'); return null; }
                return editId;
            } else {
                const res = await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
                if (!res.ok) { const err = await res.text(); console.error('POST error', res.status, err); alert('登録に失敗しました'); return null; }
                return (await res.json()).id;
            }
        }

        // 共通: LTトーク保存ヘルパー
        async function _saveLtTalks(sessionId, talks) {
            const talkData = talks.map((t, i) => ({
                title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana || '',
                speaker_org: t.speaker_org || '', speaker_title: t.speaker_title || '',
                speaker_photo: t.speaker_photo || '',
                start_time: t.start_time || '', end_time: t.end_time || '', order: i,
                is_representative: t.is_representative || 0
            }));
            const res = await fetch(API + `/api/sessions/${sessionId}/lt-talks`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(talkData)
            });
            if (!res.ok) { alert('LTトークの保存に失敗しました'); return; }
            const savedTalks = await res.json();
            for (let i = 0; i < talks.length; i++) {
                if (talks[i].photoFile && savedTalks[i]) {
                    const fd2 = new FormData();
                    fd2.append('photo', talks[i].photoFile);
                    const res3 = await fetch(API + `/api/sessions/${sessionId}/lt-talks/${savedTalks[i].id}/photo`, { method: 'POST', body: fd2 });
                    if (!res3.ok) { alert(`LT登壇者 ${i+1} の写真アップロードに失敗しました`); }
                }
            }
        }

        // 共通: 配置クリアヘルパー
        async function _doClearAssignments(assignmentIds) {
            for (const id of assignmentIds) {
                const res = await fetch(API + `/api/assignments/${id}`, { method: 'DELETE' });
                if (!res.ok) { alert('配置の削除に失敗しました'); return false; }
            }
            await loadSchedule();
            return true;
        }

        // 共通: 自動配置ヘルパー
        async function _doAutoAssign(ids, fillOnly) {
            const res = await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids, fill_only: !!fillOnly })
            });
            if (!res.ok) { alert('自動配置に失敗しました'); return null; }
            const data = await res.json();
            await loadSchedule();
            return data;
        }

        // 共通: タイムライングリッド ラベル生成
        function _buildGridLabels(cfg) {
            if (!cfg) return [];
            const labels = [];
            const slotsPerLabel = 15 / SLOT_MIN;
            const labelCount = cfg.totalSlots / slotsPerLabel;
            for (let i = 0; i < labelCount; i++) {
                const t = new Date(cfg.minTime + i * slotsPerLabel * cfg.slotMs);
                const mins = t.getMinutes();
                // 開始時刻が15分刻みに乗らない場合でも、行の範囲内にある00/30分の時刻を表示する
                const rowEnd = new Date(t.getTime() + slotsPerLabel * cfg.slotMs);
                let label = null;
                for (const mark of [0, 30]) {
                    const cand = new Date(t);
                    cand.setMinutes(mark, 0, 0);
                    if (cand < t) cand.setHours(cand.getHours() + 1);
                    if (cand >= t && cand < rowEnd) { label = cand; break; }
                }
                labels.push({
                    text: label ? label.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '',
                    gridRow: i * slotsPerLabel + 2, span: slotsPerLabel,
                    isHour: mins === 0, isHalf: mins === 30, isQuarter: mins === 15 || mins === 45,
                });
            }
            return labels;
        }

        // 共通: グリッド部屋一覧
        function _buildGridRooms(entries) {
            const map = new Map();
            entries.forEach(e => {
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        }

        // 共通: グリッドスタイル
        function _buildGridStyle(cfg, rooms) {
            if (!cfg) return {};
            return {
                gridTemplateColumns: `70px repeat(${rooms.length}, 150px)`,
                gridTemplateRows: `auto repeat(${cfg.totalSlots}, 20px)`,
            };
        }

        // 共通: 時間→行番号
        function _timeToRow(cfg, dt) {
            if (!cfg) return 2;
            const t = new Date(dt).getTime();
            return Math.round((t - cfg.minTime) / cfg.slotMs) + 2;
        }

        // 共通: セッションスタイル
        function _buildSessionStyle(cfg, rooms, entry) {
            if (!cfg) return {};
            const startRow = _timeToRow(cfg, entry.session.start_time);
            const endRow = _timeToRow(cfg, entry.session.end_time);
            const ci = rooms.findIndex(([rid]) => rid === entry.session.room_id);
            return { gridRow: `${startRow} / ${endRow}`, gridColumn: `${ci + 2}` };
        }

        async function autoAssign() {
            if (!confirm('スタッフを自動配置します。現在の配置はすべて上書きされます。よろしいですか？')) return;
            const data = await _doAutoAssign(sessionSchedule.value.map(e => e.session.id));
            if (!data) return;
            scheduleMsg.value = { type: 'success', text: `配置完了: ${data.fully_assigned}/${data.total_sessions} セッション` };
            scheduleMsgError.value = data.understaffed && data.understaffed.length
                ? '人員不足: ' + data.understaffed.map(u => u.session_title).join(', ') : '';
            selectedSessions.clear();
        }
        async function autoAssignSelected() {
            const ids = [...selectedSessions];
            if (!confirm(`選択した${ids.length}件のセッションを再配置します。よろしいですか？`)) return;
            const data = await _doAutoAssign(ids);
            if (!data) return;
            scheduleMsg.value = { type: 'success', text: `再配置完了: ${data.fully_assigned}/${data.total_sessions} セッション` };
            scheduleMsgError.value = data.understaffed && data.understaffed.length
                ? '人員不足: ' + data.understaffed.map(u => u.session_title).join(', ') : '';
            selectedSessions.clear();
        }
        async function autoAssignFill() {
            if (!confirm('未配置・不足分のみ配置します。既存の配置は維持されます。よろしいですか？')) return;
            const data = await _doAutoAssign(sessionSchedule.value.map(e => e.session.id), true);
            if (!data) return;
            scheduleMsg.value = { type: 'success', text: `配置完了: ${data.fully_assigned}/${data.total_sessions} セッション` };
            scheduleMsgError.value = data.understaffed && data.understaffed.length
                ? '人員不足: ' + data.understaffed.map(u => u.session_title).join(', ') : '';
            selectedSessions.clear();
        }
        async function clearAssignments() {
            if (!confirm('セッション担当の配置をすべてクリアします。よろしいですか？')) return;
            const ids = sessionSchedule.value.flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            if (await _doClearAssignments(ids)) {
                scheduleMsg.value = { type: 'success', text: 'セッション担当の配置をクリアしました' };
                scheduleMsgError.value = '';
            }
        }

        // ====================================================================
        //  セッショングループ別 スケジュール・管理
        // ====================================================================
        const groupSchedule = computed(() => {
            const result = {};
            const dkeys = dynamicCatKeys.value;
            const defaultGid = sessionGroups.value.length ? sessionGroups.value[0].id : null;
            sessionGroups.value.forEach(g => {
                result[g.id] = schedule.value.filter(e => {
                    const gid = e.session.group_id;
                    const match = gid === g.id || (gid == null && g.id === defaultGid);
                    return match && !dkeys.includes(e.session.category) && e.session.category !== 'overall';
                });
            });
            return result;
        });
        // グループ内の日付一覧（sessions.valueから直接計算）
        function grpDates(gid) {
            const dates = new Set();
            const defaultGid = sessionGroups.value.length ? sessionGroups.value[0].id : null;
            sessions.value.filter(s => s.group_id === gid || (s.group_id == null && gid === defaultGid)).forEach(s => {
                if (s.start_time) dates.add(s.start_time.slice(0, 10));
            });
            return [...dates].sort();
        }
        // 日付に紐づくグループ名一覧
        // 日付タブで絞り込んだグループスケジュール
        function grpDateFiltered(gid) {
            const sess = groupSchedule.value[gid] || [];
            const tab = grpDateTabs[gid];
            if (!tab || tab === 0) return sess;
            return sess.filter(e => e.session.start_time && e.session.start_time.startsWith(tab));
        }
        function filteredGroupSchedule(gid) {
            const filter = groupStaffFilters[gid];
            const sess = grpDateFiltered(gid);
            if (!filter) return sess;
            return sess.filter(e => _isStaffSession(e, filter));
        }
        function filteredGroupSessions(gid) {
            const filter = groupStaffFilters[gid];
            const sess = grpDateFiltered(gid);
            if (!filter) return sess;
            return sess.filter(e => _isStaffSession(e, filter));
        }
        function groupSessionOpacity(gid, entry) {
            const filter = groupStaffFilters[gid];
            if (!filter) return 1;
            return _isStaffSession(entry, filter) ? 1 : 0.15;
        }

        // グループ別セッション管理
        function groupSessions(gid) {
            const defaultGid = sessionGroups.value.length ? sessionGroups.value[0].id : null;
            let list = sessions.value.filter(s => {
                const match = s.group_id === gid || (s.group_id == null && gid === defaultGid);
                return match && !dynamicCatKeys.value.includes(s.category) && s.category !== 'overall';
            });
            const tab = grpDateTabs[gid];
            if (tab && tab !== 0) {
                list = list.filter(s => s.start_time && s.start_time.startsWith(tab));
            }
            return list;
        }
        function cancelEditGroupSession(gid) {
            Object.assign(groupSessForms[gid], {
                editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
                room_id: selectableRooms.value.length ? selectableRooms.value[0].id : null,
                category: 'general', required_staff: 0, english_required: false, description: '', notes: '', currentPhoto: '', photoFile: null, photoPreview: '',
                speaker_org: '', speaker_title: '', speaker_profile: ''
            });
            // Clear LT talks for this group
            if (groupSessForms[gid]._ltTalks) groupSessForms[gid]._ltTalks.splice(0);
        }
        function editGroupSession(gid, s) {
            Object.assign(groupSessForms[gid], {
                editId: s.id, title: s.title, speaker: s.speaker, speaker_kana: s.speaker_kana || '',
                start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                room_id: s.room_id, category: s.category,
                required_staff: s.required_staff, english_required: !!s.english_required,
                description: s.description || '', notes: s.notes || '',
                currentPhoto: s.speaker_photo || '', photoFile: null, photoPreview: '',
                speaker_org: s.speaker_org || '', speaker_title: s.speaker_title || '',
                speaker_profile: s.speaker_profile || ''
            });
            if (!groupSessForms[gid]._ltTalks) groupSessForms[gid]._ltTalks = reactive([]);
            groupSessForms[gid]._ltTalks.splice(0);
            if (s.lt_talks && s.lt_talks.length) {
                s.lt_talks.forEach(t => groupSessForms[gid]._ltTalks.push({
                    title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana || '',
                    speaker_org: t.speaker_org || '', speaker_title: t.speaker_title || '',
                    speaker_photo: t.speaker_photo || '',
                    start_time: t.start_time ? toLocalInput(t.start_time) : '',
                    end_time: t.end_time ? toLocalInput(t.end_time) : '',
                    photoFile: null, photoPreview: '',
                    is_representative: t.is_representative || 0
                }));
            }
            // 配置表から編集した場合は一覧の該当行までスクロールする
            nextTick(() => {
                const el = document.getElementById('grp-edit-' + s.id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
        function onGroupPhotoChange(gid, event) {
            const file = event.target.files[0];
            // タブを移動するとinput要素が作り直されFileが失われるため、状態側に保持する
            groupSessForms[gid].photoFile = file || null;
            groupSessForms[gid].photoPreview = file ? URL.createObjectURL(file) : '';
        }
        async function submitGroupSession(gid) {
            const form = groupSessForms[gid];
            const missing = [];
            if (!form.title) missing.push('セッション名');
            if (!dynamicCatKeys.value.includes(form.category) && !isMultiSpeakerCat(form.category) && !form.speaker) missing.push('スピーカー');
            if (!form.start_time) missing.push('開始時間');
            if (!form.end_time) missing.push('終了時間');
            if (!form.room_id) missing.push('部屋');
            if (missing.length) { alert('未入力の項目があります: ' + missing.join('、')); return; }
            const talks = form._ltTalks || [];
            const fd = new FormData();
            fd.append('title', form.title);
            if (isMultiSpeakerCat(form.category) && talks.length) {
                fd.append('speaker', talks.map(t => t.speaker).filter(Boolean).join(', '));
            } else if (dynamicCatKeys.value.includes(form.category)) {
                fd.append('speaker', '-');
            } else {
                fd.append('speaker', form.speaker);
            }
            fd.append('speaker_kana', form.speaker_kana);
            fd.append('speaker_org', form.speaker_org);
            fd.append('speaker_title', form.speaker_title);
            fd.append('speaker_profile', form.speaker_profile);
            const st = form.start_time; const et = form.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', form.room_id);
            fd.append('category', form.category);
            fd.append('required_staff', form.required_staff);
            fd.append('english_required', form.english_required);
            fd.append('description', form.description);
            fd.append('notes', form.notes);
            fd.append('group_id', gid);
            if (form.photoFile) fd.append('speaker_photo', form.photoFile);

            const sessionId = await _saveSession(fd, form.editId);
            if (!sessionId) return;
            if (isMultiSpeakerCat(form.category) && talks.length) {
                await _saveLtTalks(sessionId, talks);
            }
            cancelEditGroupSession(gid);
            await loadSessions(); await loadSchedule();
        }
        async function deleteGroupSession(gid, id) {
            if (!confirm('このセッションを削除しますか？')) return;
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (groupSessForms[gid] && groupSessForms[gid].editId === id) cancelEditGroupSession(gid);
            const res = await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('セッションの削除に失敗しました'); return; }
            await loadSessions();
            await loadSchedule();
        }

        // グループ別自動配置
        async function autoAssignGroup(gid) {
            if (!confirm('このグループのスタッフを自動配置します。現在の配置はすべて上書きされます。よろしいですか？')) return;
            const data = await _doAutoAssign((groupSchedule.value[gid] || []).map(e => e.session.id));
            if (!data) return;
            groupScheduleMsgs[gid] = `配置完了: ${data.fully_assigned}/${data.total_sessions} セッション`;
            if (groupSelectedSessions[gid]) groupSelectedSessions[gid].clear();
        }
        async function autoAssignGroupSelected(gid) {
            const ids = [...(groupSelectedSessions[gid] || [])];
            if (!ids.length) return;
            if (!confirm(`選択した${ids.length}件のセッションを再配置します。よろしいですか？`)) return;
            const data = await _doAutoAssign(ids);
            if (!data) return;
            groupScheduleMsgs[gid] = `再配置完了: ${data.fully_assigned}/${data.total_sessions} セッション`;
            if (groupSelectedSessions[gid]) groupSelectedSessions[gid].clear();
        }
        async function autoAssignGroupFill(gid) {
            if (!confirm('未配置・不足分のみ配置します。既存の配置は維持されます。よろしいですか？')) return;
            const data = await _doAutoAssign((groupSchedule.value[gid] || []).map(e => e.session.id), true);
            if (!data) return;
            groupScheduleMsgs[gid] = `配置完了: ${data.fully_assigned}/${data.total_sessions} セッション`;
            if (groupSelectedSessions[gid]) groupSelectedSessions[gid].clear();
        }
        async function clearGroupAssignments(gid) {
            if (!confirm('このグループの配置をすべてクリアします。よろしいですか？')) return;
            const ids = (groupSchedule.value[gid] || []).flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            if (await _doClearAssignments(ids)) {
                groupScheduleMsgs[gid] = '配置をクリアしました';
            }
        }
        function toggleGroupSessionSelect(gid, id) {
            if (!groupSelectedSessions[gid]) groupSelectedSessions[gid] = new Set();
            if (groupSelectedSessions[gid].has(id)) groupSelectedSessions[gid].delete(id);
            else groupSelectedSessions[gid].add(id);
        }
        function toggleGroupSelectAll(gid) {
            const all = groupSchedule.value[gid] || [];
            if (!groupSelectedSessions[gid]) groupSelectedSessions[gid] = new Set();
            if (groupSelectedSessions[gid].size === all.length) {
                groupSelectedSessions[gid].clear();
            } else {
                all.forEach(e => groupSelectedSessions[gid].add(e.session.id));
            }
        }

        // グループ別タイムライングリッド
        // グループ全体の時間範囲（全カテゴリ含む）を統一的に算出
        const unifiedGroupConfig = computed(() => {
            const result = {};
            const slotMs = SLOT_MIN * 60 * 1000;
            sessionGroups.value.forEach(g => {
                const sess = schedule.value.filter(e => e.session.group_id === g.id);
                if (!sess.length) { result[g.id] = null; return; }
                let minT = Infinity, maxT = -Infinity;
                sess.forEach(e => {
                    const s = new Date(e.session.start_time).getTime();
                    const end = new Date(e.session.end_time).getTime();
                    if (s < minT) minT = s;
                    if (end > maxT) maxT = end;
                });
                minT = Math.floor(minT / slotMs) * slotMs;
                maxT = Math.ceil(maxT / slotMs) * slotMs;
                result[g.id] = { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
            });
            return result;
        });
        function grpGridConfig(gid) {
            const tab = grpDateTabs[gid];
            if (tab && tab !== 0) {
                // 日付選択時: その日のセッションから時間範囲を算出
                const slotMs = SLOT_MIN * 60 * 1000;
                const daySessions = sessions.value.filter(s => s.start_time && s.start_time.startsWith(tab));
                if (!daySessions.length) return null;
                let minT = Infinity, maxT = -Infinity;
                daySessions.forEach(s => {
                    const st = new Date(s.start_time).getTime();
                    const end = new Date(s.end_time).getTime();
                    if (st < minT) minT = st;
                    if (end > maxT) maxT = end;
                });
                minT = Math.floor(minT / slotMs) * slotMs;
                maxT = Math.ceil(maxT / slotMs) * slotMs;
                return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
            }
            return unifiedGroupConfig.value[gid] || null;
        }
        function grpGridRooms(gid) { return _buildGridRooms(grpDateFiltered(gid)); }
        function grpGridStyle(gid) { return _buildGridStyle(grpGridConfig(gid), grpGridRooms(gid)); }
        function grpTimeToRow(gid, dt) { return _timeToRow(grpGridConfig(gid), dt); }
        function grpGridLabels(gid) { return _buildGridLabels(grpGridConfig(gid)); }
        function grpSessionStyle(gid, entry) { return _buildSessionStyle(grpGridConfig(gid), grpGridRooms(gid), entry); }
        const grpSelectedSession = reactive({});
        function grpSelectedEntry(gid) {
            const sid = grpSelectedSession[gid];
            if (!sid) return null;
            return (groupSchedule.value[gid] || []).find(e => e.session.id === sid) || null;
        }

        // ====================================================================
        //  動的カテゴリ管理（受付案内・懇親会など共通）
        // ====================================================================
        function cancelEditCategory(catKey) {
            Object.assign(categoryForms[catKey], {
                editId: null, title: '', start_time: '', end_time: '',
                room_id: selectableRooms.value.length ? selectableRooms.value[0].id : null,
                required_staff: 2, english_required: false, notes: ''
            });
        }
        function editCategory(catKey, s) {
            Object.assign(categoryForms[catKey], {
                editId: s.id, title: s.title,
                start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                room_id: s.room_id, required_staff: s.required_staff,
                english_required: !!s.english_required, notes: s.notes || ''
            });
            // 配置表から編集した場合は一覧の該当行までスクロールする
            nextTick(() => {
                const el = document.getElementById('cat-edit-' + s.id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
        async function submitCategory(catKey) {
            const form = categoryForms[catKey];
            const cat = categories.value.find(c => c.key === catKey);
            const catLabel = cat ? cat.label : catKey;
            const missing = [];
            if (!form.title) missing.push(catLabel + '名');
            if (!form.start_time) missing.push('開始時間');
            if (!form.end_time) missing.push('終了時間');
            if (!form.room_id) missing.push('部屋');
            if (missing.length) { alert('未入力の項目があります: ' + missing.join('、')); return; }
            const fd = new FormData();
            fd.append('title', form.title);
            fd.append('speaker', '-');
            const st = form.start_time; const et = form.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', form.room_id);
            fd.append('category', catKey);
            fd.append('required_staff', form.required_staff);
            fd.append('english_required', form.english_required);
            fd.append('notes', form.notes);
            fd.append('description', ''); fd.append('speaker_kana', '');
            fd.append('speaker_org', ''); fd.append('speaker_title', ''); fd.append('speaker_profile', '');
            const gid = catGroupTabs[catKey];
            if (gid && Number.isInteger(gid)) fd.append('group_id', gid);
            const sessionId = await _saveSession(fd, form.editId);
            if (!sessionId) return;
            cancelEditCategory(catKey);
            await loadSessions(); await loadSchedule();
        }
        async function deleteCategory(catKey, id) {
            const cat = categories.value.find(c => c.key === catKey);
            if (!confirm(`この${cat ? cat.label : catKey}を削除します。よろしいですか？`)) return;
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (categoryForms[catKey] && categoryForms[catKey].editId === id) cancelEditCategory(catKey);
            const res = await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('セッションの削除に失敗しました'); return; }
            await loadSessions(); await loadSchedule();
        }
        async function autoAssignCategory(catKey) {
            const cat = categories.value.find(c => c.key === catKey);
            const label = cat ? cat.label : catKey;
            if (!confirm(`${label}スタッフを自動配置します。現在の${label}配置は上書きされます。よろしいですか？`)) return;
            const data = await _doAutoAssign((categorySessions.value[catKey] || []).map(e => e.session.id));
            if (!data) return;
            categoryAssignMsgs[catKey] = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
        }
        async function clearCategoryAssignments(catKey) {
            const cat = categories.value.find(c => c.key === catKey);
            const label = cat ? cat.label : catKey;
            if (!confirm(`${label}のスタッフ配置をすべてクリアします。よろしいですか？`)) return;
            const ids = (categorySessions.value[catKey] || []).flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            if (await _doClearAssignments(ids)) {
                categoryAssignMsgs[catKey] = `${label}の配置をクリアしました`;
            }
        }
        async function autoAssignCategorySelected(catKey) {
            const ids = [...(catSelectedSessions[catKey] || [])];
            if (!ids.length) return;
            if (!confirm(`選択した${ids.length}件を再配置します。よろしいですか？`)) return;
            const data = await _doAutoAssign(ids);
            if (!data) return;
            categoryAssignMsgs[catKey] = `再配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            if (catSelectedSessions[catKey]) catSelectedSessions[catKey].clear();
        }
        async function autoAssignCategoryFill(catKey) {
            if (!confirm('未配置・不足分のみ配置します。既存の配置は維持されます。よろしいですか？')) return;
            const data = await _doAutoAssign((categorySessions.value[catKey] || []).map(e => e.session.id), true);
            if (!data) return;
            categoryAssignMsgs[catKey] = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            if (catSelectedSessions[catKey]) catSelectedSessions[catKey].clear();
        }
        function toggleCatSessionSelect(catKey, id) {
            if (!catSelectedSessions[catKey]) catSelectedSessions[catKey] = new Set();
            if (catSelectedSessions[catKey].has(id)) catSelectedSessions[catKey].delete(id);
            else catSelectedSessions[catKey].add(id);
        }
        function toggleCatSelectAll(catKey) {
            const all = catGroupFiltered(catKey);
            if (!catSelectedSessions[catKey]) catSelectedSessions[catKey] = new Set();
            if (catSelectedSessions[catKey].size === all.length) {
                catSelectedSessions[catKey].clear();
            } else {
                all.forEach(e => catSelectedSessions[catKey].add(e.session.id));
            }
        }

        // ====================================================================
        //  タイムライングリッド (5分刻み、Excel結合セル風)
        // ====================================================================

        // タイムライン設定（セッションカテゴリのみ）
        const tlConfig = computed(() => {
            if (!sessionSchedule.value.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            let minT = Infinity, maxT = -Infinity;
            sessionSchedule.value.forEach(e => {
                const s = new Date(e.session.start_time).getTime();
                const end = new Date(e.session.end_time).getTime();
                if (s < minT) minT = s;
                if (end > maxT) maxT = end;
            });
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        });

        // 部屋一覧（セッションカテゴリのみ）
        const tlRooms = computed(() => _buildGridRooms(sessionSchedule.value));

        // グリッドスタイル
        const tlGridStyle = computed(() => _buildGridStyle(tlConfig.value, tlRooms.value));

        // 時間 → グリッド行番号
        function timeToRow(dt) { return _timeToRow(tlConfig.value, dt); }

        // 15分ごとの時間ラベル + 背景セル
        const tlLabels = computed(() => _buildGridLabels(tlConfig.value));

        // セッションのグリッドスタイル
        function tlSessionStyle(entry) { return _buildSessionStyle(tlConfig.value, tlRooms.value, entry); }

        // ====================================================================
        //  ドラッグ & ドロップ（Googleカレンダー風）
        // ====================================================================
        const DRAG_THRESHOLD = 10; // px — 明確なドラッグ意図が必要
        // タッチ/マウス共通: 座標取得
        function _evXY(e) {
            if (e.touches && e.touches.length) return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
            if (e.changedTouches && e.changedTouches.length) return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
            return { clientX: e.clientX, clientY: e.clientY };
        }
        const _isTouch = (e) => e.type && e.type.startsWith('touch');

        const drag = reactive({
            active: false,    // ドラッグ中（閾値を超えた後）
            pending: false,   // mousedown済み、閾値未到達
            mode: null,       // 'move' | 'resize-top' | 'resize-bottom'
            sessionId: null,
            origStartRow: 0,
            origEndRow: 0,
            origColIdx: 0,
            curStartRow: 0,
            curEndRow: 0,
            curColIdx: 0,
            startMouseY: 0,
            startMouseX: 0,
            gridEl: null,
            rowHeight: 20,
            colWidths: [],    // 各列の左端X座標（grid相対）
        });

        function dragSessionStyle(entry) {
            if (drag.active && drag.sessionId === entry.session.id) {
                return {
                    gridRow: `${drag.curStartRow} / ${drag.curEndRow}`,
                    gridColumn: `${drag.curColIdx + 2}`,
                    opacity: 0.85,
                    zIndex: 50,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    transition: 'none',
                    cursor: drag.mode === 'move' ? 'grabbing' : 'ns-resize',
                };
            }
            return {
                ...tlSessionStyle(entry),
                opacity: matrixSessionOpacity(entry),
            };
        }

        function _computeColBounds(gridEl) {
            // 各部屋ヘッダーの中心X座標を収集（列判定用）
            const headers = gridEl.querySelectorAll('.tl-room-header');
            const gridRect = gridEl.getBoundingClientRect();
            const bounds = [];
            headers.forEach(h => {
                const r = h.getBoundingClientRect();
                bounds.push({
                    left: r.left - gridRect.left,
                    right: r.right - gridRect.left,
                    center: (r.left + r.right) / 2 - gridRect.left,
                });
            });
            return bounds;
        }

        function _colFromMouseX(mouseX, gridEl, colBounds) {
            const gridRect = gridEl.getBoundingClientRect();
            const x = mouseX - gridRect.left;
            // 最も近い列の中心を探す
            let bestCol = 0;
            let bestDist = Infinity;
            for (let i = 0; i < colBounds.length; i++) {
                if (x >= colBounds[i].left && x <= colBounds[i].right) {
                    return i; // マウスがその列内にある
                }
                const dist = Math.abs(x - colBounds[i].center);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestCol = i;
                }
            }
            return bestCol;
        }

        function onDragStart(e, entry) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (matrixLocked.value) return;
            e.preventDefault();

            const { clientX, clientY } = _evXY(e);
            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = clientY - rect.top;

            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - clientY <= edgeThreshold) mode = 'resize-bottom';

            const gridEl = sessionEl.closest('.tl-grid');
            const colBounds = _computeColBounds(gridEl);

            const startRow = timeToRow(entry.session.start_time);
            const endRow = timeToRow(entry.session.end_time);
            const ci = tlRooms.value.findIndex(([rid]) => rid === entry.session.room_id);

            dragDidMove = false;
            drag.pending = true;
            drag.active = false;
            drag.mode = mode;
            drag.sessionId = entry.session.id;
            drag.origStartRow = startRow;
            drag.origEndRow = endRow;
            drag.origColIdx = ci;
            drag.curStartRow = startRow;
            drag.curEndRow = endRow;
            drag.curColIdx = ci;
            drag.startMouseY = clientY;
            drag.startMouseX = clientX;
            drag.gridEl = gridEl;
            drag.colWidths = colBounds;

            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onDragEnd);
        }

        function onDragMove(e) {
            if (!drag.pending && !drag.active) return;
            if (_isTouch(e)) e.preventDefault();

            const { clientX, clientY } = _evXY(e);
            const dx = clientX - drag.startMouseX;
            const dy = clientY - drag.startMouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // 閾値チェック
            if (!drag.active) {
                if (dist < DRAG_THRESHOLD) return;
                drag.pending = false;
                drag.active = true;
                dragDidMove = true;
            }

            const rowDelta = Math.round(dy / drag.rowHeight);

            if (drag.mode === 'move') {
                const newStart = drag.origStartRow + rowDelta;
                const span = drag.origEndRow - drag.origStartRow;
                if (newStart >= 2) {
                    drag.curStartRow = newStart;
                    drag.curEndRow = newStart + span;
                }
                drag.curColIdx = _colFromMouseX(clientX, drag.gridEl, drag.colWidths);
            } else if (drag.mode === 'resize-top') {
                const newStart = drag.origStartRow + rowDelta;
                if (newStart >= 2 && newStart < drag.origEndRow - 1) {
                    drag.curStartRow = newStart;
                }
            } else if (drag.mode === 'resize-bottom') {
                const newEnd = drag.origEndRow + rowDelta;
                if (newEnd > drag.origStartRow + 1) {
                    drag.curEndRow = newEnd;
                }
            }
        }

        // 共通: ドラッグ終了処理
        function _toISO(ms) {
            const d = new Date(ms);
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }
        async function _doDragEnd(cfg, rooms, mouseupHandler) {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', mouseupHandler);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('touchend', mouseupHandler);

            if (!drag.active) {
                drag.pending = false;
                drag.sessionId = null;
                return;
            }

            const changed = drag.curStartRow !== drag.origStartRow
                         || drag.curEndRow !== drag.origEndRow
                         || drag.curColIdx !== drag.origColIdx;

            if (changed) {
                const newStartMs = cfg.minTime + (drag.curStartRow - 2) * cfg.slotMs;
                const newEndMs = cfg.minTime + (drag.curEndRow - 2) * cfg.slotMs;
                const newRoomId = rooms[drag.curColIdx]?.[0];

                if (!newRoomId || newStartMs >= newEndMs) {
                    drag.active = false;
                    drag.pending = false;
                    drag.sessionId = null;
                    return;
                }

                try {
                    const resp = await fetch(API + `/api/sessions/${drag.sessionId}/move`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            start_time: _toISO(newStartMs),
                            end_time: _toISO(newEndMs),
                            room_id: newRoomId,
                        }),
                    });
                    if (resp.ok) {
                        await loadSchedule();
                        await loadSessions();
                        await loadStaffAssignments();
                    } else {
                        const err = await resp.json().catch(() => ({}));
                        alert(err.detail || '移動できませんでした');
                        await loadSchedule();
                        await loadStaffAssignments();
                    }
                } catch (err) {
                    console.error('Move failed:', err);
                }
            }

            drag.active = false;
            drag.pending = false;
            drag.mode = null;
            drag.sessionId = null;
        }

        async function onDragEnd() {
            await _doDragEnd(tlConfig.value, tlRooms.value, onDragEnd);
        }

        function dragCursor(e) {
            if (drag.active) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = e.clientY - rect.top;
            if (relY <= edgeThreshold || rect.bottom - e.clientY <= edgeThreshold) {
                e.currentTarget.style.cursor = 'ns-resize';
            } else {
                e.currentTarget.style.cursor = 'grab';
            }
        }

        // グループ担当用ドラッグスタイル
        function grpDragSessionStyle(gid, entry) {
            if (drag.active && drag.sessionId === entry.session.id) {
                return {
                    gridRow: `${drag.curStartRow} / ${drag.curEndRow}`,
                    gridColumn: `${drag.curColIdx + 2}`,
                    opacity: 0.85,
                    zIndex: 50,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    transition: 'none',
                    cursor: drag.mode === 'move' ? 'grabbing' : 'ns-resize',
                };
            }
            return {
                ...grpSessionStyle(gid, entry),
                opacity: groupSessionOpacity(gid, entry),
                cursor: 'grab',
            };
        }

        // グループ担当用ドラッグ開始
        function onGrpDragStart(e, gid, entry, force) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (!force && groupLocks[gid]) return;
            e.preventDefault();

            const { clientX, clientY } = _evXY(e);
            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = clientY - rect.top;

            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - clientY <= edgeThreshold) mode = 'resize-bottom';

            const gridEl = sessionEl.closest('.tl-grid');
            const colBounds = _computeColBounds(gridEl);

            const startRow = grpTimeToRow(gid, entry.session.start_time);
            const endRow = grpTimeToRow(gid, entry.session.end_time);
            const rms = grpGridRooms(gid);
            const ci = rms.findIndex(([rid]) => rid === entry.session.room_id);

            dragDidMove = false;
            drag.pending = true;
            drag.active = false;
            drag.mode = mode;
            drag.sessionId = entry.session.id;
            drag.origStartRow = startRow;
            drag.origEndRow = endRow;
            drag.origColIdx = ci;
            drag.curStartRow = startRow;
            drag.curEndRow = endRow;
            drag.curColIdx = ci;
            drag.startMouseY = clientY;
            drag.startMouseX = clientX;
            drag.gridEl = gridEl;
            drag.colWidths = colBounds;
            drag._grpId = gid;

            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onGrpDragEnd);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onGrpDragEnd);
        }

        async function onGrpDragEnd() {
            const gid = drag._grpId;
            await _doDragEnd(grpGridConfig(gid), grpGridRooms(gid), onGrpDragEnd);
        }

        // 部屋ごとのセッション一覧（セッションカテゴリのみ）
        const tlRoomSessions = computed(() => {
            const map = new Map();
            tlRooms.value.forEach(([rid]) => map.set(rid, []));
            sessionSchedule.value.forEach(e => {
                const rid = e.session.room_id;
                if (map.has(rid)) map.get(rid).push(e.session);
            });
            map.forEach(list => list.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)));
            return map;
        });

        // 休憩ブロック（部屋ごと、セッション間の隙間）
        const tlBreaks = computed(() => {
            const cfg = tlConfig.value;
            if (!cfg) return [];
            const breaks = [];
            tlRooms.value.forEach(([rid], ci) => {
                const sessList = tlRoomSessions.value.get(rid) || [];
                for (let i = 0; i < sessList.length - 1; i++) {
                    const gapStartMs = new Date(sessList[i].end_time).getTime();
                    const gapEndMs = new Date(sessList[i + 1].start_time).getTime();
                    if (gapEndMs > gapStartMs) {
                        const startRow = timeToRow(sessList[i].end_time);
                        const endRow = timeToRow(sessList[i + 1].start_time);
                        if (endRow > startRow) {
                            breaks.push({
                                style: {
                                    gridRow: `${startRow} / ${endRow}`,
                                    gridColumn: `${ci + 2}`,
                                }
                            });
                        }
                    }
                }
            });
            return breaks;
        });


        // ===== 動的カテゴリ タイムライングリッド（共通ファクトリ） =====
        function catGridConfig(catKey) {
            const sess = catGroupFiltered(catKey);
            if (!sess.length) return null;
            const tab = catGroupTabs[catKey];
            // 日付選択時はその日のセッション全体の時間範囲を使用
            const slotMs = SLOT_MIN * 60 * 1000;
            let minT = Infinity, maxT = -Infinity;
            // 同じ日付の全セッション（カテゴリ問わず）から時間範囲を算出
            const targetSessions = (tab && tab !== 0 && typeof tab === 'string')
                ? sessions.value.filter(s => s.start_time && s.start_time.startsWith(tab))
                : (tab && typeof tab === 'number' && unifiedGroupConfig.value[tab])
                    ? null // グループ指定時はunifiedGroupConfigを使用
                    : sessions.value;
            if (targetSessions === null) return unifiedGroupConfig.value[tab];
            targetSessions.forEach(s => {
                const st = new Date(s.start_time).getTime();
                const end = new Date(s.end_time).getTime();
                if (st < minT) minT = st;
                if (end > maxT) maxT = end;
            });
            if (minT === Infinity) return null;
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        }
        function catGridRooms(catKey) { return _buildGridRooms(catGroupFiltered(catKey)); }
        function catGridStyle(catKey) { return _buildGridStyle(catGridConfig(catKey), catGridRooms(catKey)); }
        function catTimeToRow(catKey, dt) { return _timeToRow(catGridConfig(catKey), dt); }
        function catGridLabels(catKey) { return _buildGridLabels(catGridConfig(catKey)); }
        function catSessionStyle(catKey, entry) { return _buildSessionStyle(catGridConfig(catKey), catGridRooms(catKey), entry); }
        const catSelectedSession = reactive({});
        function catSelectedEntry(catKey) {
            const sid = catSelectedSession[catKey];
            if (!sid) return null;
            return (categorySessions.value[catKey] || []).find(e => e.session.id === sid) || null;
        }

        // カテゴリ担当用ドラッグ
        function catDragSessionStyle(catKey, entry) {
            if (drag.active && drag.sessionId === entry.session.id) {
                return {
                    gridRow: `${drag.curStartRow} / ${drag.curEndRow}`,
                    gridColumn: `${drag.curColIdx + 2}`,
                    opacity: 0.85, zIndex: 50,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    transition: 'none',
                    cursor: drag.mode === 'move' ? 'grabbing' : 'ns-resize',
                };
            }
            return { ...catSessionStyle(catKey, entry), opacity: catSessionOpacity(catKey, entry), ...allSessionBg(catKey), cursor: 'grab' };
        }
        function onCatDragStart(e, catKey, entry, force) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (!force && categoryLocks[catKey]) return;
            e.preventDefault();
            const { clientX, clientY } = _evXY(e);
            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = clientY - rect.top;
            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - clientY <= edgeThreshold) mode = 'resize-bottom';
            const gridEl = sessionEl.closest('.tl-grid');
            const colBounds = _computeColBounds(gridEl);
            const cfg = catGridConfig(catKey);
            const rms = catGridRooms(catKey);
            const startRow = _timeToRow(cfg, entry.session.start_time);
            const endRow = _timeToRow(cfg, entry.session.end_time);
            const ci = rms.findIndex(([rid]) => rid === entry.session.room_id);
            dragDidMove = false;
            drag._catKey = catKey;
            Object.assign(drag, {
                pending: true, active: false, mode, sessionId: entry.session.id,
                origStartRow: startRow, origEndRow: endRow, origColIdx: ci,
                curStartRow: startRow, curEndRow: endRow, curColIdx: ci,
                startMouseY: clientY, startMouseX: clientX, gridEl, colWidths: colBounds,
            });
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onCatDragEnd);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onCatDragEnd);
        }
        async function onCatDragEnd() {
            const catKey = drag._catKey;
            await _doDragEnd(catGridConfig(catKey), catGridRooms(catKey), onCatDragEnd);
        }

        // --- 全体スケジュール担当 ---
        const overallLocked = ref(true);
        const overallStaffFilter = ref(0);
        const overallAssignMsg = ref('');
        const overallSelectedSessions = reactive(new Set());
        const overallDateTab = ref(0);
        const overallSchedule = computed(() => {
            return schedule.value.filter(e => e.session.category === 'overall');
        });
        function overallDateFiltered() {
            const sess = overallSchedule.value;
            const tab = overallDateTab.value;
            if (!tab || tab === 0) return sess;
            return sess.filter(e => e.session.start_time && e.session.start_time.startsWith(tab));
        }
        function filteredOverallSchedule() {
            const filter = overallStaffFilter.value;
            const sess = overallDateFiltered();
            if (!filter) return sess;
            return sess.filter(e => _isStaffSession(e, filter));
        }
        // 全体スケジュールが全て「全員対象」なら、スタッフで絞り込んでも結果が変わらない。
        // 効かない操作を見せないため、個別配置のある項目がある場合だけ絞り込みを出す。
        const overallFilterUsable = computed(() =>
            overallSchedule.value.some(e => e.session.required_staff !== -1));
        function overallSessionOpacity(entry) {
            if (!overallStaffFilter.value) return 1;
            return _isStaffSession(entry, overallStaffFilter.value) ? 1 : 0.15;
        }
        function overallDates() {
            const dates = new Set();
            sessions.value.filter(s => s.category === 'overall').forEach(s => {
                if (s.start_time) dates.add(s.start_time.slice(0, 10));
            });
            return [...dates].sort();
        }
        function toggleOverallSessionSelect(id) {
            if (overallSelectedSessions.has(id)) overallSelectedSessions.delete(id);
            else overallSelectedSessions.add(id);
        }
        function toggleOverallSelectAll() {
            const filtered = overallDateFiltered();
            if (overallSelectedSessions.size === filtered.length) {
                overallSelectedSessions.clear();
            } else {
                filtered.forEach(e => overallSelectedSessions.add(e.session.id));
            }
        }
        async function autoAssignOverall() {
            if (!confirm('全体スケジュールを自動配置します。よろしいですか？')) return;
            const data = await _doAutoAssign(overallDateFiltered().map(e => e.session.id));
            if (!data) return;
            overallAssignMsg.value = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
        }
        async function autoAssignOverallSelected() {
            const ids = [...overallSelectedSessions];
            if (!ids.length) return;
            const data = await _doAutoAssign(ids);
            if (!data) return;
            overallAssignMsg.value = `再配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            overallSelectedSessions.clear();
        }
        async function clearOverallAssignments() {
            if (!confirm('全体スケジュールの配置をクリアしますか？')) return;
            const ids = overallDateFiltered().flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            if (await _doClearAssignments(ids)) {
                overallAssignMsg.value = '配置をクリアしました';
            }
        }
        // overallGrid (マトリクス用)
        function ovGridConfig() {
            const sess = overallDateFiltered();
            if (!sess.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            const tab = overallDateTab.value;
            const targetSessions = (tab && tab !== 0)
                ? sessions.value.filter(s => s.start_time && s.start_time.startsWith(tab))
                : sessions.value.filter(s => s.category === 'overall');
            let minT = Infinity, maxT = -Infinity;
            targetSessions.forEach(s => {
                const st = new Date(s.start_time).getTime();
                const end = new Date(s.end_time).getTime();
                if (st < minT) minT = st;
                if (end > maxT) maxT = end;
            });
            if (minT === Infinity) return null;
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        }
        function ovGridRooms() { return _buildGridRooms(overallDateFiltered()); }
        function ovGridStyle() { return _buildGridStyle(ovGridConfig(), ovGridRooms()); }
        function ovTimeToRow(dt) { return _timeToRow(ovGridConfig(), dt); }
        function ovGridLabels() { return _buildGridLabels(ovGridConfig()); }
        function ovSessionStyle(entry) { return _buildSessionStyle(ovGridConfig(), ovGridRooms(), entry); }

        // 全体スケジュール管理用グリッド (allGroupTab使用)
        function ovManageFiltered() {
            const sess = overallSchedule.value;
            const tab = allGroupTab.value;
            if (!tab || tab === 0) return sess;
            return sess.filter(e => e.session.start_time && e.session.start_time.startsWith(tab));
        }
        function ovManageGridConfig() {
            const sess = ovManageFiltered();
            if (!sess.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            const tab = allGroupTab.value;
            const targetSessions = (tab && tab !== 0)
                ? sessions.value.filter(s => s.start_time && s.start_time.startsWith(tab))
                : sessions.value.filter(s => s.category === 'overall');
            let minT = Infinity, maxT = -Infinity;
            targetSessions.forEach(s => {
                const st = new Date(s.start_time).getTime();
                const end = new Date(s.end_time).getTime();
                if (st < minT) minT = st;
                if (end > maxT) maxT = end;
            });
            if (minT === Infinity) return null;
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        }
        function ovManageGridRooms() { return _buildGridRooms(ovManageFiltered()); }
        function ovManageGridStyle() { return _buildGridStyle(ovManageGridConfig(), ovManageGridRooms()); }
        function ovManageGridLabels() { return _buildGridLabels(ovManageGridConfig()); }
        function ovManageSessionStyle(entry) { return _buildSessionStyle(ovManageGridConfig(), ovManageGridRooms(), entry); }

        // 全体スケジュール管理用ドラッグ
        function ovManageDragSessionStyle(entry) {
            if (drag.active && drag.sessionId === entry.session.id) {
                return {
                    gridRow: `${drag.curStartRow} / ${drag.curEndRow}`,
                    gridColumn: `${drag.curColIdx + 2}`,
                    opacity: 0.85, zIndex: 50,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    transition: 'none',
                    cursor: drag.mode === 'move' ? 'grabbing' : 'ns-resize',
                };
            }
            return { ...ovManageSessionStyle(entry), ...allSessionBg('overall'), cursor: 'grab' };
        }
        function onOvManageDragStart(e, entry) {
            if (!_isTouch(e) && e.button !== 0) return;
            e.preventDefault();
            const { clientX, clientY } = _evXY(e);
            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = clientY - rect.top;
            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - clientY <= edgeThreshold) mode = 'resize-bottom';
            const gridEl = sessionEl.closest('.tl-grid');
            const colBounds = _computeColBounds(gridEl);
            const cfg = ovManageGridConfig();
            const rms = ovManageGridRooms();
            const startRow = _timeToRow(cfg, entry.session.start_time);
            const endRow = _timeToRow(cfg, entry.session.end_time);
            const ci = rms.findIndex(([rid]) => rid === entry.session.room_id);
            dragDidMove = false;
            Object.assign(drag, {
                pending: true, active: false, mode, sessionId: entry.session.id,
                origStartRow: startRow, origEndRow: endRow, origColIdx: ci,
                curStartRow: startRow, curEndRow: endRow, curColIdx: ci,
                startMouseY: clientY, startMouseX: clientX, gridEl, colWidths: colBounds,
            });
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onOvManageDragEnd);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onOvManageDragEnd);
        }
        async function onOvManageDragEnd() {
            await _doDragEnd(ovManageGridConfig(), ovManageGridRooms(), onOvManageDragEnd);
        }

        // 全体スケジュール担当用ドラッグ
        function ovDragSessionStyle(entry) {
            if (drag.active && drag.sessionId === entry.session.id) {
                return {
                    gridRow: `${drag.curStartRow} / ${drag.curEndRow}`,
                    gridColumn: `${drag.curColIdx + 2}`,
                    opacity: 0.85, zIndex: 50,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                    transition: 'none',
                    cursor: drag.mode === 'move' ? 'grabbing' : 'ns-resize',
                };
            }
            return { ...ovSessionStyle(entry), opacity: overallSessionOpacity(entry), ...allSessionBg('overall'), cursor: 'grab' };
        }
        function onOvDragStart(e, entry) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (overallLocked.value) return;
            e.preventDefault();
            const { clientX, clientY } = _evXY(e);
            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = clientY - rect.top;
            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - clientY <= edgeThreshold) mode = 'resize-bottom';
            const gridEl = sessionEl.closest('.tl-grid');
            const colBounds = _computeColBounds(gridEl);
            const cfg = ovGridConfig();
            const rms = ovGridRooms();
            const startRow = _timeToRow(cfg, entry.session.start_time);
            const endRow = _timeToRow(cfg, entry.session.end_time);
            const ci = rms.findIndex(([rid]) => rid === entry.session.room_id);
            dragDidMove = false;
            Object.assign(drag, {
                pending: true, active: false, mode, sessionId: entry.session.id,
                origStartRow: startRow, origEndRow: endRow, origColIdx: ci,
                curStartRow: startRow, curEndRow: endRow, curColIdx: ci,
                startMouseY: clientY, startMouseX: clientX, gridEl, colWidths: colBounds,
            });
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onOvDragEnd);
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onOvDragEnd);
        }
        async function onOvDragEnd() {
            await _doDragEnd(ovGridConfig(), ovGridRooms(), onOvDragEnd);
        }

        // --- 全体スケジュール（表示用） ---
        const allGroupTab = ref(0); // 0=全日程, 日付文字列=日別
        const allStaffFilter = ref(0);
        const allSelectedSession = ref(null);
        const allSelectedEntry = computed(() => {
            if (!allSelectedSession.value) return null;
            return allSchedule.value.find(e => e.session.id === allSelectedSession.value) || null;
        });
        const allAssignMsg = ref('');

        // 全体スケジュール登録フォーム
        // 全体スケジュールは既定で全員（required_staff = -1）を対象にする
        const ALL_STAFF = -1;
        const allOvForm = reactive({
            editId: null, title: '', start_time: '', end_time: '', notes: '', all_staff: true
        });
        function cancelAllOverall() {
            Object.assign(allOvForm, { editId: null, title: '', start_time: '', end_time: '', notes: '', all_staff: true });
        }
        async function submitAllOverall() {
            const fd = new FormData();
            fd.append('title', allOvForm.title);
            fd.append('speaker', '-');
            const st = allOvForm.start_time; const et = allOvForm.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', overallRoomId.value || (rooms.value.length ? rooms.value[0].id : 1));
            fd.append('category', 'overall');
            fd.append('required_staff', allOvForm.all_staff ? ALL_STAFF : 0);
            fd.append('english_required', false);
            fd.append('notes', allOvForm.notes);
            fd.append('description', ''); fd.append('speaker_kana', '');
            fd.append('speaker_org', ''); fd.append('speaker_title', ''); fd.append('speaker_profile', '');
            const sessionId = await _saveSession(fd, allOvForm.editId);
            if (!sessionId) return;
            cancelAllOverall();
            await loadSessions(); await loadSchedule();
        }

        // ポップアップから全体スケジュールの編集
        function editAllEntry(s) {
            allSelectedSession.value = null;
            if (s.category === 'overall') {
                Object.assign(allOvForm, {
                    editId: s.id, title: s.title,
                    start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                    notes: s.notes || '', all_staff: s.required_staff === ALL_STAFF
                });
                // 配置表から編集した場合は一覧の該当行までスクロールする
                nextTick(() => {
                    const el = document.getElementById('ov-edit-' + s.id);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
            }
        }
        async function deleteAllEntry(id, category) {
            const label = CATEGORY_LABELS.value[category] || 'この項目';
            if (!confirm(`この${label}を削除します。よろしいですか？`)) return;
            // 編集中の項目を削除したら編集状態も解除する（追加フォームが出なくなるため）
            if (allOvForm.editId === id) cancelAllOverall();
            allSelectedSession.value = null;
            const res = await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('セッションの削除に失敗しました'); return; }
            await loadSessions(); await loadSchedule();
        }

        async function autoAssignAll() {
            if (!confirm('全体を自動配置します。現在の配置は上書きされます。よろしいですか？')) return;
            const data = await _doAutoAssign(allSchedule.value.map(e => e.session.id));
            if (!data) return;
            allAssignMsg.value = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
        }
        const overallSessions = computed(() => {
            let list = sessions.value.filter(s => s.category === 'overall');
            if (allGroupTab.value && allGroupTab.value !== 0) {
                list = list.filter(s => s.start_time && s.start_time.startsWith(allGroupTab.value));
            }
            return list.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
        });
        const allSchedule = computed(() => {
            if (!allGroupTab.value) return schedule.value;
            // 日付文字列でフィルタリング
            return schedule.value.filter(e => e.session.start_time && e.session.start_time.startsWith(allGroupTab.value));
        });
        // 全日程タイムライン: 日付別にソート済みリスト
        // 同一時間帯の場合: 全体→セッション→カテゴリ(order順)
        const allTimelineByGroup = computed(() => {
            const catOrderMap = {};
            categories.value.forEach(c => { catOrderMap[c.key] = c.order; });
            function catPriority(cat) {
                if (cat === 'overall') return 0;
                if (cat in catOrderMap) return 2 + catOrderMap[cat];
                return 1; // session系 (general/tech/keynote/workshop/lt)
            }
            const result = {};
            // スタッフで絞り込んだ場合はその人の予定だけを残す
            const staffId = allStaffFilter.value;
            catDates.value.forEach(date => {
                result[date] = schedule.value
                    .filter(e => e.session.start_time && e.session.start_time.startsWith(date))
                    .filter(e => _isStaffSession(e, staffId))
                    .sort((a, b) => {
                        const timeDiff = new Date(a.session.start_time) - new Date(b.session.start_time);
                        if (timeDiff !== 0) return timeDiff;
                        return catPriority(a.session.category) - catPriority(b.session.category);
                    });
            });
            return result;
        });
        // 全日程タイムラインの表示件数（絞り込み結果が空かどうかの判定に使う）
        const allTimelineTotal = computed(() =>
            Object.values(allTimelineByGroup.value).reduce((n, list) => n + list.length, 0));
        const allConfig = computed(() => {
            if (!allSchedule.value.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            let minT = Infinity, maxT = -Infinity;
            allSchedule.value.forEach(e => {
                const s = new Date(e.session.start_time).getTime();
                const end = new Date(e.session.end_time).getTime();
                if (s < minT) minT = s;
                if (end > maxT) maxT = end;
            });
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        });
        // 列構成は表示中の範囲（全日程 or 選択日）で計算し、未使用の部屋列は表示しない
        const hasOverall = computed(() => allSchedule.value.some(e => e.session.category === 'overall'));
        // セッション用の部屋（動的カテゴリ/overall除外）
        const allSessionRooms = computed(() => {
            const dkeys = dynamicCatKeys.value;
            const map = new Map();
            allSchedule.value.forEach(e => {
                if (dkeys.includes(e.session.category) || e.session.category === 'overall') return;
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        // 動的カテゴリ別列
        const allCategoryCols = computed(() => {
            const result = {};
            categories.value.forEach(c => {
                const map = new Map();
                allSchedule.value.forEach(e => {
                    if (e.session.category !== c.key) return;
                    const r = e.session.room;
                    if (r && !map.has(r.id)) map.set(r.id, r.name);
                });
                result[c.key] = [...map.entries()].sort((a, b) => a[0] - b[0]);
            });
            return result;
        });
        // 全列 = 全体 + セッション部屋 + 動的カテゴリ列
        const allColumns = computed(() => {
            const cols = [];
            if (hasOverall.value) cols.push({ id: 'overall', name: '全体', type: 'overall' });
            allSessionRooms.value.forEach(([id, name]) => cols.push({ id, name, type: 'session' }));
            categories.value.forEach(c => {
                const catCols = allCategoryCols.value[c.key] || [];
                catCols.forEach(([id, name]) => cols.push({ id: `${c.key}_${id}`, name: `${c.label}: ${name}`, type: c.key, roomId: id }));
            });
            return cols;
        });
        const allGridStyle = computed(() => {
            const cfg = allConfig.value;
            if (!cfg) return {};
            const totalCols = allColumns.value.length;
            return {
                gridTemplateColumns: `70px repeat(${totalCols}, 150px)`,
                gridTemplateRows: `auto repeat(${cfg.totalSlots}, 20px)`,
            };
        });
        function allTimeToRow(dt) {
            const cfg = allConfig.value;
            const t = new Date(dt).getTime();
            return Math.round((t - cfg.minTime) / cfg.slotMs) + 2;
        }
        const allLabels = computed(() => {
            const cfg = allConfig.value;
            if (!cfg) return [];
            const labels = [];
            const slotsPerLabel = 15 / SLOT_MIN;
            const labelCount = cfg.totalSlots / slotsPerLabel;
            for (let i = 0; i < labelCount; i++) {
                const t = new Date(cfg.minTime + i * slotsPerLabel * cfg.slotMs);
                const mins = t.getMinutes();
                // 開始時刻が15分刻みに乗らない場合でも、行の範囲内にある00/30分の時刻を表示する
                const rowEnd = new Date(t.getTime() + slotsPerLabel * cfg.slotMs);
                let label = null;
                for (const mark of [0, 30]) {
                    const cand = new Date(t);
                    cand.setMinutes(mark, 0, 0);
                    if (cand < t) cand.setHours(cand.getHours() + 1);
                    if (cand >= t && cand < rowEnd) { label = cand; break; }
                }
                labels.push({
                    text: label ? label.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '',
                    gridRow: i * slotsPerLabel + 2, span: slotsPerLabel,
                    isHour: mins === 0, isHalf: mins === 30, isQuarter: mins === 15 || mins === 45,
                });
            }
            return labels;
        });
        function allSessionStyle(entry) {
            const startRow = allTimeToRow(entry.session.start_time);
            const endRow = allTimeToRow(entry.session.end_time);
            const cat = entry.session.category;
            // allColumns の中から該当列を探す
            let ci = -1;
            if (cat === 'overall') {
                ci = allColumns.value.findIndex(c => c.type === 'overall');
            } else if (dynamicCatKeys.value.includes(cat)) {
                ci = allColumns.value.findIndex(c => c.type === cat && c.roomId === entry.session.room_id);
            } else {
                ci = allColumns.value.findIndex(c => c.type === 'session' && c.id === entry.session.room_id);
            }
            if (ci < 0) ci = 0;
            return { gridRow: `${startRow} / ${endRow}`, gridColumn: `${ci + 2}` };
        }
        // カテゴリ色をHEXから明るいグラデーションに変換
        function _hexToGradient(hex) {
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            const light1 = `rgba(${r},${g},${b},0.12)`, light2 = `rgba(${r},${g},${b},0.22)`;
            return `linear-gradient(135deg,${light1},${light2})`;
        }
        const CAT_BG = computed(() => {
            const base = {
                general: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
                tech: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
                workshop: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
                keynote: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
                lt: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
                overall: { background: 'linear-gradient(135deg,#fff3e0,#ffe0b2)', borderColor: '#e65100' },
            };
            categories.value.forEach(c => {
                base[c.key] = { background: _hexToGradient(c.color), borderColor: c.color };
            });
            return base;
        });
        function allSessionBg(cat) { return CAT_BG.value[cat] || CAT_BG.value.general; }
        function allSessionOpacity(entry) {
            if (!allStaffFilter.value) return 1;
            return _isStaffSession(entry, allStaffFilter.value) ? 1 : 0.15;
        }

        // --- リアルタイム表示 ---
        const REALTIME_WINDOW_MIN = 30;   // 「まもなく開始」「終了直後」とみなす時間（分）
        const REALTIME_STEP_MIN = 5;      // 時刻指定スライダーの刻み（分）
        const REALTIME_TICK_MS = 15000;   // 区分判定を見直す間隔（秒表示の時計とは別）
        const REALTIME_RELOAD_MS = 60000; // 配置データを読み直す間隔（実際は ±25% ばらつかせる）
        const realtimeLiveNow = ref(new Date());
        // 表示する時刻を任意の時点に固定する（当日以外でも進行状況を確認できる）
        const realtimeFixed = ref(false);
        const realtimeFixedMinutes = ref(0);
        // スライダーの範囲は登録済みセッションの最初〜最後
        const realtimeRange = computed(() => {
            let min = null, max = null;
            sessions.value.forEach(s => {
                const st = new Date(s.start_time).getTime();
                const en = new Date(s.end_time).getTime();
                if (min === null || st < min) min = st;
                if (max === null || en > max) max = en;
            });
            if (min === null) return null;
            // 前後にも余裕を持たせる（開始前・終了後の表示を確認できるように）
            const start = min - REALTIME_WINDOW_MIN * 60000;
            const end = max + REALTIME_WINDOW_MIN * 60000;
            return { start, end, totalMinutes: Math.max(1, Math.round((end - start) / 60000)) };
        });
        const realtimeNow = computed(() => {
            const r = realtimeRange.value;
            if (realtimeFixed.value && r) {
                return new Date(r.start + realtimeFixedMinutes.value * 60000);
            }
            return realtimeLiveNow.value;
        });
        function toggleRealtimeFixed() {
            realtimeFixed.value = !realtimeFixed.value;
            if (!realtimeFixed.value) return;
            const r = realtimeRange.value;
            if (!r) return;
            // 現在時刻が範囲内ならそこから、範囲外ならイベント開始時点から始める
            const now = Date.now();
            const offset = now >= r.start && now <= r.end ? Math.round((now - r.start) / 60000) : 0;
            realtimeFixedMinutes.value = Math.round(offset / REALTIME_STEP_MIN) * REALTIME_STEP_MIN;
        }
        function shiftRealtimeFixed(minutes) {
            const r = realtimeRange.value;
            if (!r) return;
            realtimeFixedMinutes.value = Math.min(r.totalMinutes, Math.max(0, realtimeFixedMinutes.value + minutes));
        }
        let realtimeTickTimer = null;
        let realtimeReloadTimer = null;
        function startRealtime() {
            realtimeLiveNow.value = new Date();
            if (!realtimeTickTimer) {
                // 区分判定・残り時間の更新用。秒表示の時計は rt-clock コンポーネントが別に持つ。
                // ここで毎秒更新するとルートの render がアプリ全体（全パネル）を毎秒作り直すため間隔を空ける。
                realtimeTickTimer = setInterval(() => { realtimeLiveNow.value = new Date(); }, REALTIME_TICK_MS);
            }
            if (!realtimeReloadTimer) {
                // 配置の変更を拾うため定期的に読み直す。
                // 全員が同時に画面を開くと同じ瞬間にリクエストが集中するため、
                // 間隔を 60秒 ±25%（45〜75秒）でばらつかせる
                const nextReloadDelay = () => REALTIME_RELOAD_MS * 0.75 + Math.random() * REALTIME_RELOAD_MS * 0.5;
                const reloadTick = () => {
                    loadSchedule();
                    realtimeReloadTimer = setTimeout(reloadTick, nextReloadDelay());
                };
                realtimeReloadTimer = setTimeout(reloadTick, nextReloadDelay());
            }
        }
        function stopRealtime() {
            if (realtimeTickTimer) { clearInterval(realtimeTickTimer); realtimeTickTimer = null; }
            if (realtimeReloadTimer) { clearTimeout(realtimeReloadTimer); realtimeReloadTimer = null; }
        }
        // 時刻指定中は固定時刻を rt-clock に渡す（未指定なら null＝実時刻を自分で刻む）
        const realtimeFixedDate = computed(() => (realtimeFixed.value ? realtimeNow.value : null));
        const realtimeBuckets = computed(() => {
            const now = realtimeNow.value.getTime();
            const soonLimit = now + REALTIME_WINDOW_MIN * 60000;
            const recentLimit = now - REALTIME_WINDOW_MIN * 60000;
            const staffId = realtimeStaffFilter.value;
            const running = [], upcoming = [], ended = [];
            schedule.value.forEach(e => {
                if (!_isStaffSession(e, staffId)) return;
                const st = new Date(e.session.start_time).getTime();
                const en = new Date(e.session.end_time).getTime();
                if (st <= now && now < en) running.push(e);
                else if (st > now && st <= soonLimit) upcoming.push(e);
                else if (en <= now && en >= recentLimit) ended.push(e);
            });
            const byStart = (a, b) => new Date(a.session.start_time) - new Date(b.session.start_time);
            return { running: running.sort(byStart), upcoming: upcoming.sort(byStart), ended: ended.sort(byStart) };
        });
        const realtimeEmpty = computed(() => {
            const b = realtimeBuckets.value;
            return !b.running.length && !b.upcoming.length && !b.ended.length;
        });
        // 同じ会場での前後1件（時間帯に関わらず、その部屋の直前・直後の予定）
        const realtimeNeighbors = computed(() => {
            const byRoom = {};
            schedule.value.forEach(e => {
                const rid = e.session.room_id;
                (byRoom[rid] = byRoom[rid] || []).push(e);
            });
            const map = {};
            Object.values(byRoom).forEach(list => {
                list.sort((a, b) => new Date(a.session.start_time) - new Date(b.session.start_time));
                list.forEach((e, i) => {
                    map[e.session.id] = { prev: list[i - 1] || null, next: list[i + 1] || null };
                });
            });
            return map;
        });
        // 前後のセッションの時刻表示。日付が違えば月日から出す（複数日開催で翌日の予定を当日と誤読しないため）
        function realtimeNeighborTime(entry, base, which) {
            if (!entry || !base) return '';
            const t = which === 'end' ? entry.session.end_time : entry.session.start_time;
            const sameDay = String(t).slice(0, 10) === String(base.session.start_time).slice(0, 10);
            return sameDay ? fmtShort(t) : fmt(t);
        }
        // 前後のセッションの担当者名（全員対象・未配置も文字で示す）
        function realtimeStaffNames(entry) {
            if (!entry) return '';
            if (entry.session.required_staff === -1) return '全員';
            if (!entry.assigned_staff.length) return '未配置';
            return entry.assigned_staff.map(a => a.staff.name).join('、');
        }
        function _minutesBetween(a, b) { return Math.max(0, Math.round((b - a) / 60000)); }
        // 「1時間20分」のように表示する
        function realtimeDuration(minutes) {
            if (minutes < 60) return `${minutes}分`;
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            return m ? `${h}時間${m}分` : `${h}時間`;
        }
        function realtimeRemaining(entry) {
            return realtimeDuration(_minutesBetween(realtimeNow.value.getTime(), new Date(entry.session.end_time).getTime()));
        }
        function realtimeUntilStart(entry) {
            return realtimeDuration(_minutesBetween(realtimeNow.value.getTime(), new Date(entry.session.start_time).getTime()));
        }
        function realtimeSinceEnd(entry) {
            return realtimeDuration(_minutesBetween(new Date(entry.session.end_time).getTime(), realtimeNow.value.getTime()));
        }
        // 進行状況バー（0〜100%）
        function realtimeProgress(entry) {
            const st = new Date(entry.session.start_time).getTime();
            const en = new Date(entry.session.end_time).getTime();
            if (en <= st) return 100;
            const p = ((realtimeNow.value.getTime() - st) / (en - st)) * 100;
            return Math.min(100, Math.max(0, Math.round(p)));
        }

        // セッションフォームコンポーネントへ親のヘルパーを渡す
        provide('sessFormApi', {
            isMultiSpeakerCat, speakerLabel, autoSetEndTime, autoSetLTEndTime,
            dynamicCatKeys: () => dynamicCatKeys.value,
            selectableRooms: () => selectableRooms.value,
            sessionCatOptions: () => sessionCatOptions.value,
            onGroupPhotoChange, onPhotoPaste, addLTTalk, toggleRepresentative, onLTTalkPhoto,
            submitGroupSession, cancelEditGroupSession,
        });
        provide('catFormApi', {
            autoSetEndTime,
            selectableRooms: () => selectableRooms.value,
            submitCategory, cancelEditCategory,
        });
        provide('staffFormApi', {
            fmt, fmtShort, catLabel, sessionLabel,
            photoPreview: () => staffPhotoPreview.value,
            onNewStaffPhoto, onPhotoPaste, clearNewStaffPhoto, deleteStaffPhoto,
            roleDropdownOpen: () => roleDropdownOpen.value,
            toggleRoleDropdown: () => { roleDropdownOpen.value = !roleDropdownOpen.value; },
            roleOptions: () => roleOptions.value,
            eventRange: () => eventRange.value,
            eventRangeLabel: () => eventRangeLabel.value,
            editingStaffAvails: () => editingStaffAvails.value,
            editingStaffPrefs: () => editingStaffPrefs.value,
            availForm: (id) => availForms[id],
            prefForm: (id) => prefForms[id],
            addAvail, removeAvail, addPref, removePref,
            newStaffAvails: () => newStaffAvails,
            newAvailForm: () => newAvailForm,
            addNewStaffAvail,
            newStaffPrefs: () => newStaffPrefs,
            newPrefForm: () => newPrefForm,
            addNewStaffPref, removeNewStaffPref,
            availablePrefSessions: () => availablePrefSessions.value,
            nextPrefPriority: () => nextPrefPriority.value,
            submitStaff, cancelEditStaff,
        });

        onMounted(async () => {
            await loadMe();
            await loadSessionGroups();
            await loadCategories();
            loadRooms();
            loadStaffs();
            loadSessions().then(() => loadSchedule());
            loadSettings();
            // 初期表示がリアルタイムの場合は時計を動かし始める
            if (tab.value === 'realtime') startRealtime();
        });

        return {
            tab, sidebarOpen, navOpen, toggleNavSection,
            rooms, selectableRooms, overallRoomId, sessions, staffs, schedule, staffAssignments, staffAssignmentsForDetail,
            myRole, isViewer, myStaffId, myProfileSelect, selectMyStaff, clearMyStaff,
            scheduleMsg, scheduleMsgError, sessPhotoPreview, sessPhoto,
            roomForm, sessForm, staffForm, roleDropdownOpen, prefForms, availForms, ltTalks,
            venueMaps, venueMapForm, venueMapPreview, venueMapInput, mapModal,
            switchTab, catLabel, fmt, fmtShort, sortedPrefs, autoSetEndTime, entriesByDate, sessionsByDate,
            cancelEditRoom, editRoom, submitRoom, deleteRoom,
            onVenueMapChange, cancelEditVenueMap, editVenueMap, submitVenueMap, deleteVenueMap,
            sessDetailSession, sessDetailEntry, sessDetailLocked, toggleSessionDetail, toggleSessDetailLock,
            gridMenu, showGridMenu, gridMenuEdit, gridMenuDelete, gridMenuDetail,
            isMultiSpeakerCat, speakerLabel,
            onPhotoChange, onPhotoPaste, onLTTalkPhoto, autoSetLTEndTime, toggleRepresentative, cancelEditSession, editSession, submitSession, deleteSession, addLTTalk,
            calcStaffMsg, calcStaffSummary, calcRequiredStaff, calcStaffOpen, openCalcStaff,
            newStaffAvails, newAvailForm, addNewStaffAvail,
            newStaffPrefs, newPrefForm, addNewStaffPref, removeNewStaffPref, sessionTitle, sessionLabel,
            eventRange, eventRangeLabel, nextPrefPriority, availablePrefSessions,
            staffAssignCount, editingStaffPrefs, editingStaffAvails,
            submitStaff, editStaff, cancelEditStaff, deleteStaff, uploadStaffPhoto, deleteStaffPhoto, onNewStaffPhoto, clearNewStaffPhoto, staffPhotoPreview, addPref, removePref, addAvail, removeAvail,
            sessionSchedule,
            // セッショングループ
            sessionGroups, groupLocks, groupSessForms, groupStaffFilters, groupScheduleMsgs, groupSelectedSessions,
            grpDateTabs, grpDates, grpDateFiltered,
            groupSchedule, filteredGroupSchedule, filteredGroupSessions, groupSessionOpacity, groupSessions,
            cancelEditGroupSession, editGroupSession, submitGroupSession, deleteGroupSession, onGroupPhotoChange,
            autoAssignGroup, autoAssignGroupSelected, autoAssignGroupFill, clearGroupAssignments,
            toggleGroupSessionSelect, toggleGroupSelectAll,
            grpGridConfig, grpGridRooms, grpGridStyle, grpGridLabels, grpSessionStyle, grpDragSessionStyle, onGrpDragStart, grpSelectedSession, grpSelectedEntry,
            // 動的カテゴリ
            categories, dynamicCatKeys, categoryLocks, categoryForms, categoryAssignMsgs, categoryStaffFilters,
            categorySessions, catDates, catKeyDates, catGroupTabs, catGroupFiltered, catTimelineByGroup, filteredCategorySessions, catSessionOpacity,
            cancelEditCategory, editCategory, submitCategory, deleteCategory, autoAssignCategory, clearCategoryAssignments,
            catSelectedSessions, autoAssignCategorySelected, autoAssignCategoryFill, toggleCatSessionSelect, toggleCatSelectAll,
            catGridConfig, catGridRooms, catGridStyle, catGridLabels, catSessionStyle, catDragSessionStyle, onCatDragStart, catSelectedSession, catSelectedEntry,
            roleOptions,
            assignStaffSelect, availableStaffs, addAssignment, removeAssignment, setAllStaff, unsetAllStaff, addAssignmentOrAll,
            selectedSessions, toggleSessionSelect, toggleSelectAll,
            autoAssign, autoAssignSelected, autoAssignFill, clearAssignments,
            tlRooms, tlGridStyle, tlLabels, tlSessionStyle, tlBreaks,
            matrixLocked, drag, dragSessionStyle, onDragStart, dragCursor,
            exportExcel, exportBackup, backupFileName, ioMsg, ioMsgError, onBackupFileChange, importBackup,
            staffImportFileName, staffImpMsg, staffImpMsgError, onStaffImportFileChange, importStaffs,
            sessionImportFileName, sessImpMsg, sessImpMsgError, onSessionImportFileChange, importSessions,
            importResult, importResultOpen,
            resetAllData, resetMsg, resetMsgError, resetPassword,
            resetPwForm, resetPwMsg, resetPwMsgError, changeResetPassword,
            appTitle, allowOverlap, travelBufferMin, settingsForm, settingsMsg, saveSettings,
            appIcon, appIconPreview, appIconMsg, onAppIconChange, onAppIconPaste,
            saveAppIcon, deleteAppIcon, clearAppIconSelection,
            pwForm, pwMsg, pwMsgError, changePassword,
            viewerPwForm, viewerPwSet, viewerPwMsg, viewerPwMsgError, saveViewerPassword, clearViewerPassword,
            dbType,
            catSettingForm, catSettingMsg, editCatSetting, cancelCatSetting, saveCatSetting, deleteCatSetting,
            grpSettingForm, grpSettingMsg, editGrpSetting, cancelGrpSetting, saveGrpSetting, deleteGrpSetting,
            sessionCatOptions, extraSessionCats, defaultSessionCats: DEFAULT_SESSION_CATS, sessCatForm, sessCatMsg, editSessCat, cancelSessCat, saveSessCat, deleteSessCat,
            customRoles, roleSettingForm, roleSettingMsg, editRoleSetting, cancelRoleSetting, saveRoleSetting, deleteRoleSetting,
            categoryRoleLinks, catRoleLinkSelect, addCatRoleLink, removeCatRoleLink,
            groupRoleLinks, grpRoleLinkSelect, addGrpRoleLink, removeGrpRoleLink,
            staffDetailFilter, staffDetailStaffId, staffDetailMatch, staffDetailCount, matrixStaffFilter,
            staffListStaffId, filteredStaffs,
            matrixStaffOptions,
            overallSessions,
            overallLocked, overallStaffFilter, overallFilterUsable, overallAssignMsg, overallSelectedSessions, overallDateTab,
            overallSchedule, overallDateFiltered, filteredOverallSchedule, overallSessionOpacity, overallDates,
            toggleOverallSessionSelect, toggleOverallSelectAll,
            autoAssignOverall, autoAssignOverallSelected, clearOverallAssignments,
            ovGridConfig, ovGridRooms, ovGridStyle, ovGridLabels, ovSessionStyle, ovDragSessionStyle, onOvDragStart,
            ovManageFiltered, ovManageGridStyle, ovManageGridRooms, ovManageGridLabels, ovManageSessionStyle, ovManageDragSessionStyle, onOvManageDragStart,
            allGroupTab, allStaffFilter, allSchedule, allTimelineByGroup, allTimelineTotal,
            realtimeFixedDate, realtimeStaffFilter, realtimeBuckets, realtimeEmpty, realtimeNeighbors, realtimeStaffNames, realtimeNeighborTime,
            realtimeRemaining, realtimeUntilStart, realtimeSinceEnd, realtimeProgress, REALTIME_WINDOW_MIN,
            realtimeFixed, realtimeFixedMinutes, realtimeRange, toggleRealtimeFixed, shiftRealtimeFixed,
            REALTIME_STEP_MIN, allConfig, allColumns, allGridStyle, allLabels, allSessionStyle, allSessionBg, allSessionOpacity,
            allSelectedSession, allSelectedEntry, allAssignMsg,
            allOvForm, cancelAllOverall, submitAllOverall,
            editAllEntry, deleteAllEntry, autoAssignAll,
            filteredMatrixSchedule,
            matrixSessionOpacity, CAT_BG,
            abSettings, abStatus, abHistory, abMsg, abDownload,
            loadAbSettings, loadAbStatus, loadAbHistory, saveAbSettings, triggerBackupNow, deleteBackupEntry, downloadBackupEntry,
            pubApi, pubHistory, pubMsg, pubMsgError, pubApiUrl,
            loadPubApiSettings, savePubApiSettings, regenerateApiKey, clearGithubToken, publishSnapshot, loadPubHistory, activateSnapshot, deleteSnapshot, copyApiUrl, copyApiKey,
        };
    }
});

// タイムライングリッド共通コンポーネント
// セッション登録・編集フォーム（追加欄と一覧の編集行で共用）
app.component('sess-form', {
    template: '#sess-form-template',
    props: {
        grp: { type: Object, required: true },
        form: { type: Object, required: true },
    },
    setup() {
        return { h: inject('sessFormApi') };
    },
});

// 時計。毎秒の更新をこのコンポーネント内に閉じ込め、ルート（＝全パネル）の再描画を防ぐ。
// fixed が渡されているときは時刻指定中なのでタイマーを使わずその値を表示する。
app.component('rt-clock', {
    template: '#rt-clock-template',
    props: {
        fixed: { type: Date, default: null },
        color: { type: String, default: '#1a73e8' },
    },
    setup(props) {
        const now = ref(new Date());
        let timer = null;
        onMounted(() => { timer = setInterval(() => { now.value = new Date(); }, 1000); });
        onUnmounted(() => { if (timer) { clearInterval(timer); timer = null; } });
        const text = computed(() =>
            (props.fixed || now.value).toLocaleString('ja-JP', {
                year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
            }));
        return { text };
    },
});

// スタッフの登録・編集フォーム（追加欄と一覧の編集カードで共用）
app.component('staff-form', {
    template: '#staff-form-template',
    props: {
        form: { type: Object, required: true },
    },
    setup() {
        return { h: inject('staffFormApi') };
    },
});

// カテゴリ（受付・懇親会など）の登録・編集フォーム
app.component('cat-form', {
    template: '#cat-form-template',
    props: {
        cat: { type: Object, required: true },
        form: { type: Object, required: true },
    },
    setup() {
        return { h: inject('catFormApi') };
    },
});

app.component('tl-grid', {
    template: '#tl-grid-template',
    props: {
        gridStyle: { type: Object, default: () => ({}) },
        rooms: { type: Array, default: () => [] },
        labels: { type: Array, default: () => [] },
        entries: { type: Array, default: () => [] },
        color: { type: String, default: '#1a73e8' },
        entryStyle: { type: Function, required: true },
        fmtShort: { type: Function, required: true },
        showSpeaker: { type: Boolean, default: false },
    },
    emits: ['select', 'dragstart'],
});

app.mount('#app');

