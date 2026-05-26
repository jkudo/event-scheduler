const { createApp, ref, reactive, computed, onMounted } = Vue;

const app = createApp({
    setup() {
        const API = '';
        const DEFAULT_SESSION_CATS = [
            { key: 'general', label: '一般' }, { key: 'tech', label: '技術' },
            { key: 'workshop', label: 'ワークショップ' }, { key: 'keynote', label: '基調講演' },
            { key: 'panel', label: 'パネルディスカッション' }, { key: 'lt', label: 'LT' },
        ];
        const MULTI_SPEAKER_CATS = ['lt', 'panel'];
        function isMultiSpeakerCat(cat) { return MULTI_SPEAKER_CATS.includes(cat); }
        const extraSessionCats = ref([]);
        const sessionCatOptions = computed(() => [...DEFAULT_SESSION_CATS, ...extraSessionCats.value]);
        const STATIC_LABELS = { session: 'セッション', overall: '全体' };
        const SLOT_MIN = 5; // 5分刻み

        const tab = ref('all-matrix');
        const sidebarOpen = ref(false);
        const rooms = ref([]);
        const sessions = ref([]);
        const staffs = ref([]);
        const schedule = ref([]);
        const staffAssignments = ref([]);
        const scheduleMsg = ref(null);
        const scheduleMsgError = ref('');
        const sessPhotoPreview = ref('');
        const sessPhoto = ref(null);
        const matrixStaffFilter = ref(0);
        const staffDetailFilter = ref(0);

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
                if (!(c.key in catGroupTabs)) catGroupTabs[c.key] = ckDates.length ? ckDates[0] : 0;
                if (!(c.key in catSelectedSessions)) catSelectedSessions[c.key] = new Set();
            });
            if (!catSettingForm.editId) catSettingForm.order = nextCatOrder();
        }
        const dynamicCatKeys = computed(() => categories.value.map(c => c.key));
        const CATEGORY_LABELS = computed(() => {
            const m = { ...STATIC_LABELS };
            sessionCatOptions.value.forEach(c => { m[c.key] = c.label; });
            categories.value.forEach(c => { m[c.key] = c.label; });
            return m;
        });
        const roleOptions = computed(() => {
            const opts = [{ v: 'session', l: 'セッション' }];
            categories.value.forEach(c => opts.push({ v: c.key, l: c.label }));
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
                        description: '', notes: '', currentPhoto: '', photoPreview: '',
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
        const sessDetailEntry = computed(() => {
            if (!sessDetailSession.value) return null;
            return schedule.value.find(e => e.session.id === sessDetailSession.value.id) || null;
        });
        const sessDetailLocked = computed(() => {
            if (!sessDetailSession.value) return true;
            const cat = sessDetailSession.value.category;
            if (cat in categoryLocks) return categoryLocks[cat];
            const gid = sessDetailSession.value.group_id;
            if (gid && gid in groupLocks) return groupLocks[gid];
            return matrixLocked.value;
        });
        const venueMapForm = reactive({ editId: null, title: '', order: 0, currentImage: '' });
        const venueMapPreview = ref('');
        const venueMapInput = ref(null);
        const mapModal = ref(null);
        const sessForm = reactive({
            editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
            room_id: null, category: 'general', required_staff: 0, english_required: false, description: '', notes: '', currentPhoto: '',
            speaker_org: '', speaker_title: '', speaker_profile: '', group_id: null
        });
        const ltTalks = reactive([]);
        const staffForm = reactive({ editId: null, name: '', slack_name: '', emergency_contact: '', role: ['session'], experience_count: 0, english_ok: false, currentPhoto: '' });
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
            // セッション読み込み後、カテゴリタブのデフォルトを最初の日付に設定
            categories.value.forEach(c => {
                const ckd = catKeyDates(c.key);
                if (ckd.length && catGroupTabs[c.key] === 0) catGroupTabs[c.key] = ckd[0];
            });
            // グループ担当の日付タブもデフォルト設定（未設定 or 0 の場合は最初の日付に）
            sessionGroups.value.forEach(g => {
                if (!grpDateTabs[g.id]) {
                    const gDates = grpDates(g.id);
                    grpDateTabs[g.id] = gDates.length ? gDates[0] : 0;
                }
            });
            // 全体スケジュールのデフォルトタブ（未設定 or 0 の場合は最初の日付に）
            const dates = catDates.value;
            if (!allGroupTab.value && dates.length) {
                allGroupTab.value = dates[0];
            }
            if (!overallDateTab.value && dates.length) {
                overallDateTab.value = dates[0];
            }
        }
        async function loadStaffs() {
            const data = await (await fetch(API + '/api/staffs/')).json();
            staffs.value = data;
            data.forEach(s => {
                if (!prefForms[s.id]) prefForms[s.id] = { session_id: null, priority: 1 };
                if (!availForms[s.id]) availForms[s.id] = { start: '', end: '' };
            });
        }
        async function loadSchedule() {
            schedule.value = ((await (await fetch(API + '/api/assignments/schedule')).json()).schedule || []);
            // schedule読み込み後もタブのデフォルト設定を確認
            const dates = catDates.value;
            if (dates.length) {
                sessionGroups.value.forEach(g => {
                    if (!grpDateTabs[g.id]) grpDateTabs[g.id] = dates[0];
                });
                categories.value.forEach(c => {
                    const ckd = catKeyDates(c.key);
                    if (!catGroupTabs[c.key] && ckd.length) catGroupTabs[c.key] = ckd[0];
                });
                if (!allGroupTab.value) allGroupTab.value = dates[0];
                if (!overallDateTab.value) overallDateTab.value = dates[0];
            }
            // 詳細ポップアップのセッションを最新データに更新
            if (sessDetailSession.value) {
                const entry = schedule.value.find(e => e.session.id === sessDetailSession.value.id);
                if (entry) sessDetailSession.value = entry.session;
            }
        }
        async function loadStaffAssignments() {
            staffAssignments.value = ((await (await fetch(API + '/api/assignments/staff-schedule')).json()).staff_assignments || []);
        }
        // 「全員」overallセッションを全スタッフの担当に含めたスタッフ別詳細
        const CAT_PRIORITY = { overall: 0, session: 1 };
        function _catPriority(cat) {
            if (cat in CAT_PRIORITY) return CAT_PRIORITY[cat];
            // 動的カテゴリ: 受付案内系→2, 懇親会系→3, その他→2
            const c = categories.value.find(c => c.key === cat);
            if (c) return 2 + c.order * 0.01;
            return 2;
        }
        const staffAssignmentsWithAll = computed(() => {
            const allOverall = schedule.value
                .filter(e => e.session.category === 'overall' && e.session.required_staff === -1)
                .map(e => e.session);
            if (!allOverall.length) return staffAssignments.value;
            return staffAssignments.value.map(e => {
                const existingIds = new Set(e.assigned_sessions.map(s => s.id));
                const extras = allOverall.filter(s => !existingIds.has(s.id));
                if (!extras.length) return e;
                const merged = [...e.assigned_sessions, ...extras].sort((a, b) => {
                    const tc = (a.start_time || '').localeCompare(b.start_time || '');
                    if (tc !== 0) return tc;
                    return _catPriority(a.category) - _catPriority(b.category);
                });
                return { ...e, assigned_sessions: merged };
            });
        });

        function exportExcel() {
            window.open(API + '/api/export/excel', '_blank');
        }
        function exportBackup() {
            window.open(API + '/api/export/backup', '_blank');
        }
        const connpassTimeline = ref('');
        const speakerTemplate = ref('');
        const connpassBaseUrl = ref('');

        function fmtTime(dt) {
            const d = new Date(dt);
            return d.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        }

        function generateConnpassTimeline() {
            const allSess = sessions.value.filter(s => !dynamicCatKeys.value.includes(s.category) && s.category !== 'overall');
            if (!allSess.length) { connpassTimeline.value = 'セッションが登録されていません。'; return; }

            const roomMap = {};
            rooms.value.forEach(r => roomMap[r.id] = r.name);

            // Group sessions by room
            const byRoom = new Map();
            for (const s of allSess) {
                if (!byRoom.has(s.room_id)) byRoom.set(s.room_id, []);
                byRoom.get(s.room_id).push(s);
            }
            // Sort each room's sessions by start time
            byRoom.forEach(list => list.sort((a, b) => new Date(a.start_time) - new Date(b.start_time)));

            let md = '# タイムテーブル\n\n';

            for (const [roomId, sessList] of byRoom) {
                const roomName = roomMap[roomId] || `Room ${roomId}`;
                md += `## ${roomName}\n\n`;
                md += '| 時間 | セッション | 登壇者 |\n';
                md += '|:---:|:---|:---|\n';

                for (const s of sessList) {
                    const time = `${fmtTime(s.start_time)}〜${fmtTime(s.end_time)}`;
                    if (isMultiSpeakerCat(s.category) && s.lt_talks && s.lt_talks.length) {
                        const talks = s.lt_talks.map(t => {
                            const info = [t.speaker_title, t.speaker_org].filter(Boolean).join(' / ');
                            const speaker = info ? `${t.speaker}（${info}）` : t.speaker;
                            return t.title ? `「${t.title}」${speaker}` : speaker;
                        }).join('<br>');
                        md += `| ${time} | ${s.title} | ${talks} |\n`;
                    } else {
                        const info = [s.speaker_title, s.speaker_org].filter(Boolean).join(' / ');
                        const speaker = info ? `${s.speaker}（${info}）` : s.speaker;
                        md += `| ${time} | ${s.title} | ${speaker} |\n`;
                    }
                }

                md += '\n';
            }

            connpassTimeline.value = md;
        }

        function photoUrl(path) {
            if (!path) return '';
            const base = connpassBaseUrl.value.replace(/\/+$/, '');
            return base ? `${base}${path}` : path;
        }

        function generateSpeakerTemplate() {
            const allSess = sessions.value.filter(s => !dynamicCatKeys.value.includes(s.category) && s.category !== 'overall');
            if (!allSess.length) { speakerTemplate.value = 'セッションが登録されていません。'; return; }

            const sorted = [...allSess].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            const roomMap = {};
            rooms.value.forEach(r => roomMap[r.id] = r.name);

            let md = '# 登壇者一覧\n\n';

            for (const s of sorted) {
                const room = roomMap[s.room_id] || '';
                const time = `${fmtTime(s.start_time)}〜${fmtTime(s.end_time)}`;

                if (isMultiSpeakerCat(s.category) && s.lt_talks && s.lt_talks.length) {
                    md += `## ${s.title}\n`;
                    md += `${time} / ${room}\n\n`;
                    for (const t of s.lt_talks) {
                        md += `### ${t.speaker}`;
                        if (t.speaker_org || t.speaker_title) {
                            md += `（${[t.speaker_title, t.speaker_org].filter(Boolean).join(' / ')}）`;
                        }
                        md += '\n';
                        if (t.title) md += `「${t.title}」\n`;
                        md += '\n';
                    }
                } else {
                    md += `## ${s.title}\n`;
                    md += `${time} / ${room}`;
                    if (s.category !== 'general') md += ` / ${CATEGORY_LABELS.value[s.category] || s.category}`;
                    md += '\n\n';
                    if (s.speaker_photo) {
                        md += `![${s.speaker}](${photoUrl(s.speaker_photo)})\n\n`;
                    }
                    md += `### ${s.speaker}`;
                    if (s.speaker_org || s.speaker_title) {
                        md += `（${[s.speaker_title, s.speaker_org].filter(Boolean).join(' / ')}）`;
                    }
                    md += '\n';
                    if (s.speaker_profile) md += `${s.speaker_profile}\n`;
                    md += '\n';
                    if (s.description) md += `${s.description}\n\n`;
                }
            }

            speakerTemplate.value = md;
        }

        async function copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                alert('クリップボードにコピーしました');
            } catch (e) {
                // Fallback
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                alert('クリップボードにコピーしました');
            }
        }

        const backupFile = ref(null);
        const backupFileName = ref('');
        const ioMsg = ref('');
        const ioMsgError = ref(false);
        const resetMsg = ref('');
        const resetMsgError = ref(false);
        const resetPassword = ref('');
        const resetPwForm = reactive({ current: '', newPw: '' });
        const resetPwMsg = ref('');
        const resetPwMsgError = ref(false);

        // --- Settings ---
        const appTitle = ref('');
        const allowOverlap = ref(false);
        const settingsForm = reactive({ app_title: '', allow_overlap: false, timezone: 'Asia/Tokyo' });
        const settingsMsg = ref('');
        const pwForm = reactive({ current: '', newPw: '' });
        const pwMsg = ref('');
        const pwMsgError = ref(false);

        async function loadSettings() {
            try {
                const data = await fetch(API + '/api/settings/').then(r => r.json());
                if (data.app_title) {
                    appTitle.value = data.app_title;
                    settingsForm.app_title = data.app_title;
                    document.title = data.app_title;
                }
                allowOverlap.value = data.allow_overlap === '1';
                settingsForm.allow_overlap = data.allow_overlap === '1';
                if (data.timezone) settingsForm.timezone = data.timezone;
                if (data.session_categories) {
                    try { extraSessionCats.value = JSON.parse(data.session_categories); } catch (e) { extraSessionCats.value = []; }
                }
            } catch (e) { /* ignore */ }
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
                        timezone: settingsForm.timezone
                    })
                });
                appTitle.value = settingsForm.app_title;
                document.title = settingsForm.app_title;
                allowOverlap.value = settingsForm.allow_overlap;
                settingsMsg.value = '保存しました';
            } catch (e) { settingsMsg.value = '保存に失敗しました'; }
        }

        // --- セッションカテゴリ管理 ---
        const sessCatForm = reactive({ label: '', editIdx: null });
        const sessCatMsg = ref('');
        function editSessCat(idx) {
            const c = extraSessionCats.value[idx];
            sessCatForm.label = c.label; sessCatForm.editIdx = idx;
        }
        function cancelSessCat() {
            sessCatForm.label = ''; sessCatForm.editIdx = null;
        }
        function _genCatKey() {
            return 'cat_' + Date.now().toString(36);
        }
        async function saveSessCat() {
            if (!sessCatForm.label) { sessCatMsg.value = '表示名を入力してください'; return; }
            const list = [...extraSessionCats.value];
            if (sessCatForm.editIdx !== null) {
                list[sessCatForm.editIdx] = { key: list[sessCatForm.editIdx].key, label: sessCatForm.label };
            } else {
                list.push({ key: _genCatKey(), label: sessCatForm.label });
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
            if (!confirm('このカテゴリを削除しますか？')) return;
            const list = extraSessionCats.value.filter((_, i) => i !== idx);
            try {
                await fetch(API + '/api/settings/', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_categories: JSON.stringify(list) })
                });
                extraSessionCats.value = list;
                sessCatMsg.value = '削除しました';
            } catch (e) { sessCatMsg.value = '削除に失敗しました'; }
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

        async function switchTab(name) {
            tab.value = name;
            sidebarOpen.value = false;
            if (name === 'rooms') await loadRooms();
            if (name === 'venue-maps') await loadVenueMaps();
            if (name === 'staffs') { await loadSessions(); await loadStaffs(); await loadSchedule(); }
            if (name === 'all-matrix') { await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule(); }
            if (name === 'staff-detail') { await loadStaffs(); await loadSessions(); await loadSchedule(); await loadStaffAssignments(); }
            if (name === 'overall-manage') { await loadSessions(); }
            // 動的セッショングループのタブ
            for (const g of sessionGroups.value) {
                if (name === 'grp-' + g.id + '-manage') {
                    await loadRooms(); await loadSessions();
                    if (groupSessForms[g.id] && !groupSessForms[g.id].room_id && rooms.value.length) groupSessForms[g.id].room_id = rooms.value[0].id;
                    break;
                }
                if (name === 'grp-' + g.id + '-assign') {
                    await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule(); await loadStaffAssignments();
                    break;
                }
            }
            // 動的カテゴリの管理・担当タブ
            for (const c of categories.value) {
                if (name === c.key + '-manage') {
                    await loadRooms(); await loadSessions(); await loadSchedule();
                    if (categoryForms[c.key] && !categoryForms[c.key].room_id && rooms.value.length) categoryForms[c.key].room_id = rooms.value[0].id;
                    break;
                }
                if (name === c.key) {
                    await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule();
                    if (categoryForms[c.key] && !categoryForms[c.key].room_id && rooms.value.length) categoryForms[c.key].room_id = rooms.value[0].id;
                    break;
                }
            }
            if (name === 'venue-view') await loadVenueMaps();
            if (name === 'io') { await loadRooms(); await loadSessions(); }
            if (name === 'auto-backup') {
                await loadAbSettings(); await loadAbHistory(); await loadAbStatus();
                _startAbPolling();
            } else {
                _stopAbPolling();
            }
        }

        // --- auto-backup polling (タブ表示中のみ) ---
        let _abPollTimer = null;
        function _startAbPolling() {
            _stopAbPolling();
            _abPollTimer = setInterval(function() {
                if (tab.value !== 'auto-backup') { _stopAbPolling(); return; }
                var prev = abStatus.last_run;
                loadAbStatus().then(function() {
                    if (abStatus.last_run !== prev) { loadAbHistory(); }
                });
            }, 1000);
        }
        function _stopAbPolling() {
            if (_abPollTimer != null) { clearInterval(_abPollTimer); _abPollTimer = null; }
        }

        // --- 部屋 ---
        function cancelEditRoom() {
            Object.assign(roomForm, { editId: null, name: '', capacity: null, floor: 1 });
        }
        function editRoom(r) {
            Object.assign(roomForm, { editId: r.id, name: r.name, capacity: r.capacity, floor: r.floor });
        }
        async function submitRoom() {
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
            venueMapPreview.value = file ? URL.createObjectURL(file) : '';
        }
        function cancelEditVenueMap() {
            Object.assign(venueMapForm, { editId: null, title: '', order: 0, currentImage: '' });
            venueMapPreview.value = '';
            if (venueMapInput.value) venueMapInput.value.value = '';
        }
        function editVenueMap(m) {
            Object.assign(venueMapForm, { editId: m.id, title: m.title, order: m.order, currentImage: m.image });
            venueMapPreview.value = '';
            if (venueMapInput.value) venueMapInput.value.value = '';
        }
        async function submitVenueMap() {
            const fd = new FormData();
            fd.append('title', venueMapForm.title);
            fd.append('order', venueMapForm.order);
            if (venueMapInput.value && venueMapInput.value.files[0]) fd.append('image', venueMapInput.value.files[0]);
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
            if (!sessDetailSession.value) return;
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
        function addLTTalk(gid) {
            if (gid !== undefined) {
                if (!groupSessForms[gid]._ltTalks) groupSessForms[gid]._ltTalks = reactive([]);
                groupSessForms[gid]._ltTalks.push({ title: '', speaker: '', speaker_kana: '', speaker_org: '', speaker_title: '', speaker_photo: '', start_time: '', end_time: '', photoFile: null, photoPreview: '' });
            } else {
                ltTalks.push({ title: '', speaker: '', speaker_kana: '', speaker_org: '', speaker_title: '', speaker_photo: '', start_time: '', end_time: '', photoFile: null, photoPreview: '' });
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
        function autoSetLTEndTime(talk) {
            if (talk.start_time && !talk.end_time) {
                const d = new Date(talk.start_time);
                d.setMinutes(d.getMinutes() + 5);
                const pad = n => String(n).padStart(2, '0');
                talk.end_time = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
            }
        }
        function cancelEditSession() {
            Object.assign(sessForm, {
                editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
                room_id: rooms.value.length ? rooms.value[0].id : null,
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
                    speaker_photo: t.speaker_photo || '', photoFile: null, photoPreview: ''
                }));
            }
            sessPhotoPreview.value = '';
            if (sessPhoto.value) sessPhoto.value.value = '';
        }
        async function submitSession() {
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
            await loadSessions();
        }
        async function deleteSession(id) {
            const res = await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            if (!res.ok) { alert('セッションの削除に失敗しました'); return; }
            await loadSessions();
        }

        const calcStaffMsg = ref('');
        const calcStaffSummary = ref(null);
        async function calcRequiredStaff() {
            const res = await fetch(API + '/api/sessions/calc-required-staff', { method: 'POST' });
            if (!res.ok) { alert('必要人数の計算に失敗しました'); return; }
            const data = await res.json();
            calcStaffMsg.value = data.message;
            calcStaffSummary.value = {
                min: data.min_total_staff,
                comfortable: data.comfortable_total_staff,
            };
            await loadSessions();
        }

        // --- スタッフ ---
        const newStaffAvails = reactive([]);
        const newAvailForm = reactive({ start: '', end: '' });
        function addNewStaffAvail() {
            if (!newAvailForm.start || !newAvailForm.end) return;
            newStaffAvails.push({ start_time: newAvailForm.start + ':00', end_time: newAvailForm.end + ':00' });
            newAvailForm.start = '';
            newAvailForm.end = '';
        }

        const newStaffPrefs = reactive([]);
        const newPrefForm = reactive({ session_id: null, priority: 1 });
        function addNewStaffPref() {
            if (!newPrefForm.session_id) return;
            newStaffPrefs.push({ session_id: newPrefForm.session_id, priority: newPrefForm.priority || 1 });
            newPrefForm.session_id = null;
            newPrefForm.priority = 1;
        }
        function sessionTitle(id) {
            const s = sessions.value.find(s => s.id === id);
            return s ? s.title : 'セッション ' + id;
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

        async function submitStaff() {
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
                if (newStaffPhotoFile.value) {
                    const created = await res.json();
                    const fd = new FormData();
                    fd.append('photo', newStaffPhotoFile.value);
                    const resPhoto = await fetch(API + `/api/staffs/${created.id}/photo`, { method: 'POST', body: fd });
                    if (!resPhoto.ok) { alert('スタッフ写真のアップロードに失敗しました'); }
                }
            }
            cancelEditStaff();
            await loadStaffs();
        }
        function editStaff(s) {
            staffForm.editId = s.id;
            staffForm.name = s.name;
            staffForm.slack_name = s.slack_name || '';
            staffForm.emergency_contact = s.emergency_contact || '';
            staffForm.role = Array.isArray(s.role) ? [...s.role] : (s.role ? s.role.split(',') : ['session']);
            staffForm.experience_count = s.experience_count;
            staffForm.english_ok = !!s.english_ok;
            staffForm.currentPhoto = s.photo || '';
            newStaffPhotoFile.value = null;
            staffPhotoPreview.value = '';
        }
        function cancelEditStaff() {
            Object.assign(staffForm, { editId: null, name: '', slack_name: '', emergency_contact: '', role: ['session'], experience_count: 0, english_ok: false, currentPhoto: '' });
            clearNewStaffPhoto();
            newStaffAvails.splice(0);
            newAvailForm.start = '';
            newAvailForm.end = '';
            newStaffPrefs.splice(0);
            newPrefForm.session_id = null;
            newPrefForm.priority = 1;
        }
        async function deleteStaff(id) {
            if (!confirm('このスタッフを削除しますか？配置情報も削除されます。')) return;
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
            const res = await fetch(API + `/api/staffs/${staffId}/preferred-sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: f.session_id, priority: f.priority })
            });
            if (!res.ok) { alert('希望セッションの追加に失敗しました'); return; }
            await loadStaffs();
        }
        async function removePref(staffId, prefId) {
            const res = await fetch(API + `/api/staffs/${staffId}/preferred-sessions/${prefId}`, { method: 'DELETE' });
            if (!res.ok) { alert('希望セッションの削除に失敗しました'); return; }
            await loadStaffs();
        }
        async function addAvail(staffId) {
            const f = availForms[staffId];
            if (!f.start || !f.end) return;
            const res = await fetch(API + `/api/staffs/${staffId}/availabilities`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_time: f.start + ':00', end_time: f.end + ':00' })
            });
            if (!res.ok) { alert('活動可能時間の追加に失敗しました'); return; }
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
        const matrixStaffOptions = computed(() => staffs.value);

        const filteredMatrixSchedule = computed(() => {
            if (!matrixStaffFilter.value) return sessionSchedule.value;
            return sessionSchedule.value.filter(e => _hasStaff(e, matrixStaffFilter.value));
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
            return sess.filter(e => _hasStaff(e, filter));
        }
        function matrixSessionOpacity(entry) {
            if (!matrixStaffFilter.value) return 1;
            return _hasStaff(entry, matrixStaffFilter.value) ? 1 : 0.15;
        }
        function catSessionOpacity(catKey, entry) {
            const filter = categoryStaffFilters[catKey];
            if (!filter) return 1;
            return _hasStaff(entry, filter) ? 1 : 0.15;
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
            const targetRole = role || 'session';
            const sessStart = new Date(entry.session.start_time);
            const sessEnd = new Date(entry.session.end_time);
            // 全スケジュールからスタッフごとの割り当て済み時間帯を収集
            const staffBusyMap = {};
            for (const e of schedule.value) {
                for (const a of e.assigned_staff) {
                    if (!staffBusyMap[a.staff.id]) staffBusyMap[a.staff.id] = [];
                    staffBusyMap[a.staff.id].push({ start: new Date(e.session.start_time), end: new Date(e.session.end_time) });
                }
            }
            return staffs.value.filter(s => {
                if (assignedIds.has(s.id)) return false;
                if (targetRole !== 'overall') {
                    const roles = Array.isArray(s.role) ? s.role : (s.role || '').split(',');
                    if (!roles.includes(targetRole)) return false;
                }
                // 時間重複チェック（重複許可設定時はスキップ）
                if (!allowOverlap.value) {
                    const busy = staffBusyMap[s.id] || [];
                    for (const b of busy) {
                        if (sessStart < b.end && sessEnd > b.start) return false;
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
            assignStaffSelect[sessionId] = '0';
        }

        // 共通: セッション保存ヘルパー
        async function _saveSession(fd, editId) {
            if (editId) {
                const res = await fetch(API + `/api/sessions/${editId}`, { method: 'PUT', body: fd });
                if (!res.ok) { alert('セッションの更新に失敗しました'); return null; }
                return editId;
            } else {
                const res = await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
                if (!res.ok) { alert('セッションの作成に失敗しました'); return null; }
                return (await res.json()).id;
            }
        }

        // 共通: LTトーク保存ヘルパー
        async function _saveLtTalks(sessionId, talks) {
            const talkData = talks.map((t, i) => ({
                title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana || '',
                speaker_org: t.speaker_org || '', speaker_title: t.speaker_title || '',
                speaker_photo: t.speaker_photo || '',
                start_time: t.start_time || '', end_time: t.end_time || '', order: i
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
        async function _doAutoAssign(ids) {
            const res = await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
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
                labels.push({
                    text: (mins === 0 || mins === 30) ? t.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '',
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
                gridTemplateColumns: `70px repeat(${rooms.length}, 1fr)`,
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
        function dateGroupLabels(date) {
            const defaultGid = sessionGroups.value.length ? sessionGroups.value[0].id : null;
            return sessionGroups.value
                .filter(g => sessions.value.some(s => {
                    const match = s.group_id === g.id || (s.group_id == null && g.id === defaultGid);
                    return match && s.start_time && s.start_time.startsWith(date);
                }))
                .map(g => g.label);
        }
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
            return sess.filter(e => _hasStaff(e, filter));
        }
        function groupSessionOpacity(gid, entry) {
            const filter = groupStaffFilters[gid];
            if (!filter) return 1;
            return _hasStaff(entry, filter) ? 1 : 0.15;
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
                room_id: rooms.value.length ? rooms.value[0].id : null,
                category: 'general', required_staff: 0, english_required: false, description: '', notes: '', currentPhoto: '', photoPreview: '',
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
                currentPhoto: s.speaker_photo || '', photoPreview: '',
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
                    photoFile: null, photoPreview: ''
                }));
            }
        }
        function onGroupPhotoChange(gid, event) {
            const file = event.target.files[0];
            groupSessForms[gid].photoPreview = file ? URL.createObjectURL(file) : '';
        }
        async function submitGroupSession(gid) {
            const form = groupSessForms[gid];
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
            const photoInput = document.querySelector(`[data-group-photo="${gid}"]`);
            if (photoInput && photoInput.files[0]) fd.append('speaker_photo', photoInput.files[0]);

            const sessionId = await _saveSession(fd, form.editId);
            if (!sessionId) return;
            if (isMultiSpeakerCat(form.category) && talks.length) {
                await _saveLtTalks(sessionId, talks);
            }
            cancelEditGroupSession(gid);
            await loadSessions();
        }
        async function deleteGroupSession(gid, id) {
            if (!confirm('このセッションを削除しますか？')) return;
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
                room_id: rooms.value.length ? rooms.value[0].id : null,
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
        }
        async function submitCategory(catKey) {
            const form = categoryForms[catKey];
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
            if (gid) fd.append('group_id', gid);
            const sessionId = await _saveSession(fd, form.editId);
            if (!sessionId) return;
            cancelEditCategory(catKey);
            await loadSessions(); await loadSchedule();
        }
        async function deleteCategory(catKey, id) {
            const cat = categories.value.find(c => c.key === catKey);
            if (!confirm(`この${cat ? cat.label : catKey}を削除します。よろしいですか？`)) return;
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
        function onGrpDragStart(e, gid, entry) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (groupLocks[gid]) return;
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
        function onCatDragStart(e, catKey, entry) {
            if (!_isTouch(e) && e.button !== 0) return;
            if (categoryLocks[catKey]) return;
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
            return sess.filter(e => _hasStaff(e, filter));
        }
        function overallSessionOpacity(entry) {
            if (!overallStaffFilter.value) return 1;
            return _hasStaff(entry, overallStaffFilter.value) ? 1 : 0.15;
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
        const allOvForm = reactive({
            editId: null, title: '', start_time: '', end_time: '', notes: ''
        });
        function cancelAllOverall() {
            Object.assign(allOvForm, { editId: null, title: '', start_time: '', end_time: '', notes: '' });
        }
        async function submitAllOverall() {
            const fd = new FormData();
            fd.append('title', allOvForm.title);
            fd.append('speaker', '-');
            const st = allOvForm.start_time; const et = allOvForm.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', rooms.value.length ? rooms.value[0].id : 1);
            fd.append('category', 'overall');
            fd.append('required_staff', 0);
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
                    notes: s.notes || ''
                });
            }
        }
        async function deleteAllEntry(id, category) {
            const label = CATEGORY_LABELS.value[category] || 'この項目';
            if (!confirm(`この${label}を削除します。よろしいですか？`)) return;
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
            catDates.value.forEach(date => {
                result[date] = schedule.value
                    .filter(e => e.session.start_time && e.session.start_time.startsWith(date))
                    .sort((a, b) => {
                        const timeDiff = new Date(a.session.start_time) - new Date(b.session.start_time);
                        if (timeDiff !== 0) return timeDiff;
                        return catPriority(a.session.category) - catPriority(b.session.category);
                    });
            });
            return result;
        });
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
        // 列構成は全日程ベースで計算（日付フィルタで列が消えないように）
        const hasOverall = computed(() => schedule.value.some(e => e.session.category === 'overall'));
        // セッション用の部屋（動的カテゴリ/overall除外）
        const allSessionRooms = computed(() => {
            const dkeys = dynamicCatKeys.value;
            const map = new Map();
            schedule.value.forEach(e => {
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
                schedule.value.forEach(e => {
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
                gridTemplateColumns: `70px repeat(${totalCols}, 1fr)`,
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
                labels.push({
                    text: (mins === 0 || mins === 30) ? t.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '',
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
            return _hasStaff(entry, allStaffFilter.value) ? 1 : 0.15;
        }

        onMounted(async () => { await loadSessionGroups(); await loadCategories(); loadRooms(); loadStaffs(); loadSessions().then(() => loadSchedule()); loadSettings(); });

        return {
            tab, sidebarOpen, rooms, sessions, staffs, schedule, staffAssignments, staffAssignmentsWithAll,
            scheduleMsg, scheduleMsgError, sessPhotoPreview, sessPhoto,
            roomForm, sessForm, staffForm, roleDropdownOpen, prefForms, availForms, ltTalks,
            venueMaps, venueMapForm, venueMapPreview, venueMapInput, mapModal,
            switchTab, catLabel, fmt, fmtShort, sortedPrefs, autoSetEndTime,
            cancelEditRoom, editRoom, submitRoom, deleteRoom,
            onVenueMapChange, cancelEditVenueMap, editVenueMap, submitVenueMap, deleteVenueMap,
            sessDetailSession, sessDetailEntry, sessDetailLocked, toggleSessionDetail, toggleSessDetailLock,
            isMultiSpeakerCat,
            onPhotoChange, onLTTalkPhoto, autoSetLTEndTime, cancelEditSession, editSession, submitSession, deleteSession, addLTTalk,
            calcStaffMsg, calcStaffSummary, calcRequiredStaff,
            newStaffAvails, newAvailForm, addNewStaffAvail,
            newStaffPrefs, newPrefForm, addNewStaffPref, sessionTitle,
            staffAssignCount, editingStaffPrefs, editingStaffAvails,
            submitStaff, editStaff, cancelEditStaff, deleteStaff, uploadStaffPhoto, deleteStaffPhoto, onNewStaffPhoto, clearNewStaffPhoto, staffPhotoPreview, addPref, removePref, addAvail, removeAvail,
            sessionSchedule,
            // セッショングループ
            sessionGroups, groupLocks, groupSessForms, groupStaffFilters, groupScheduleMsgs, groupSelectedSessions,
            grpDateTabs, grpDates, grpDateFiltered, dateGroupLabels,
            groupSchedule, filteredGroupSchedule, groupSessionOpacity, groupSessions,
            cancelEditGroupSession, editGroupSession, submitGroupSession, deleteGroupSession, onGroupPhotoChange,
            autoAssignGroup, autoAssignGroupSelected, clearGroupAssignments,
            toggleGroupSessionSelect, toggleGroupSelectAll,
            grpGridConfig, grpGridRooms, grpGridStyle, grpGridLabels, grpSessionStyle, grpDragSessionStyle, onGrpDragStart, grpSelectedSession, grpSelectedEntry,
            // 動的カテゴリ
            categories, dynamicCatKeys, categoryLocks, categoryForms, categoryAssignMsgs, categoryStaffFilters,
            categorySessions, catDates, catKeyDates, catGroupTabs, catGroupFiltered, catTimelineByGroup, filteredCategorySessions, catSessionOpacity,
            cancelEditCategory, editCategory, submitCategory, deleteCategory, autoAssignCategory, clearCategoryAssignments,
            catSelectedSessions, autoAssignCategorySelected, toggleCatSessionSelect, toggleCatSelectAll,
            catGridConfig, catGridRooms, catGridStyle, catGridLabels, catSessionStyle, catDragSessionStyle, onCatDragStart, catSelectedSession, catSelectedEntry,
            roleOptions,
            assignStaffSelect, availableStaffs, addAssignment, removeAssignment, setAllStaff, unsetAllStaff, addAssignmentOrAll,
            selectedSessions, toggleSessionSelect, toggleSelectAll,
            autoAssign, autoAssignSelected, clearAssignments,
            tlRooms, tlGridStyle, tlLabels, tlSessionStyle, tlBreaks,
            matrixLocked, drag, dragSessionStyle, onDragStart, dragCursor,
            exportExcel, exportBackup, backupFileName, ioMsg, ioMsgError, onBackupFileChange, importBackup,
            connpassTimeline, speakerTemplate, connpassBaseUrl, generateConnpassTimeline, generateSpeakerTemplate, copyToClipboard,
            resetAllData, resetMsg, resetMsgError, resetPassword,
            resetPwForm, resetPwMsg, resetPwMsgError, changeResetPassword,
            appTitle, allowOverlap, settingsForm, settingsMsg, saveSettings,
            pwForm, pwMsg, pwMsgError, changePassword,
            catSettingForm, catSettingMsg, editCatSetting, cancelCatSetting, saveCatSetting, deleteCatSetting,
            grpSettingForm, grpSettingMsg, editGrpSetting, cancelGrpSetting, saveGrpSetting, deleteGrpSetting,
            sessionCatOptions, extraSessionCats, sessCatForm, sessCatMsg, editSessCat, cancelSessCat, saveSessCat, deleteSessCat,
            staffDetailFilter, matrixStaffFilter,
            matrixStaffOptions,
            overallSessions,
            overallLocked, overallStaffFilter, overallAssignMsg, overallSelectedSessions, overallDateTab,
            overallSchedule, overallDateFiltered, filteredOverallSchedule, overallSessionOpacity, overallDates,
            toggleOverallSessionSelect, toggleOverallSelectAll,
            autoAssignOverall, autoAssignOverallSelected, clearOverallAssignments,
            ovGridConfig, ovGridRooms, ovGridStyle, ovGridLabels, ovSessionStyle, ovDragSessionStyle, onOvDragStart,
            allGroupTab, allStaffFilter, allSchedule, allTimelineByGroup, allConfig, allColumns, allGridStyle, allLabels, allSessionStyle, allSessionBg, allSessionOpacity,
            allSelectedSession, allSelectedEntry, allAssignMsg,
            allOvForm, cancelAllOverall, submitAllOverall,
            editAllEntry, deleteAllEntry, autoAssignAll,
            filteredMatrixSchedule,
            matrixSessionOpacity, _hasStaff, CAT_BG,
            abSettings, abStatus, abHistory, abMsg, abDownload,
            loadAbSettings, loadAbStatus, loadAbHistory, saveAbSettings, triggerBackupNow, deleteBackupEntry, downloadBackupEntry,
        };
    }
});

// タイムライングリッド共通コンポーネント
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

