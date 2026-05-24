const { createApp, ref, reactive, computed, onMounted } = Vue;

createApp({
    setup() {
        const API = '';
        const CATEGORY_LABELS = { general: '一般', tech: '技術', workshop: 'ワークショップ', keynote: '基調講演', lt: 'LT', reception: '受付案内', social: '懇親会', session: 'セッション', overall: '全体' };
        const SLOT_MIN = 5; // 5分刻み

        const tab = ref('all-matrix');
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
        const rcStaffFilter = ref(0);
        const scStaffFilter = ref(0);

        let dragDidMove = false; // suppress click after drag-and-drop
        const matrixLocked = ref(true); // ドラッグ&ドロップのロック（デフォルト: ロック）
        const receptionLocked = ref(true);
        const socialLocked = ref(true);

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
            if (cat === 'reception') return receptionLocked.value;
            if (cat === 'social') return socialLocked.value;
            return matrixLocked.value;
        });
        const venueMapForm = reactive({ editId: null, title: '', order: 0, currentImage: '' });
        const venueMapPreview = ref('');
        const venueMapInput = ref(null);
        const mapModal = ref(null);
        const sessForm = reactive({
            editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
            room_id: null, category: 'general', required_staff: 1, english_required: false, description: '', notes: '', currentPhoto: '',
            speaker_org: '', speaker_title: '', speaker_profile: ''
        });
        const ltTalks = reactive([]);
        const staffForm = reactive({ editId: null, name: '', slack_name: '', role: 'session', experience_count: 0, english_ok: false });
        const prefForms = reactive({});
        const availForms = reactive({});

        // --- ユーティリティ ---
        function catLabel(cat) { return CATEGORY_LABELS[cat] || cat; }
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
        async function loadSessions() { sessions.value = await (await fetch(API + '/api/sessions/')).json(); }
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
        }
        async function loadStaffAssignments() {
            staffAssignments.value = ((await (await fetch(API + '/api/assignments/staff-schedule')).json()).staff_assignments || []);
        }

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
            const allSess = sessions.value.filter(s => !['reception', 'social', 'overall'].includes(s.category));
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
                    if (s.category === 'lt' && s.lt_talks && s.lt_talks.length) {
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
            const allSess = sessions.value.filter(s => !['reception', 'social', 'overall'].includes(s.category));
            if (!allSess.length) { speakerTemplate.value = 'セッションが登録されていません。'; return; }

            const sorted = [...allSess].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
            const roomMap = {};
            rooms.value.forEach(r => roomMap[r.id] = r.name);

            let md = '# 登壇者一覧\n\n';

            for (const s of sorted) {
                const room = roomMap[s.room_id] || '';
                const time = `${fmtTime(s.start_time)}〜${fmtTime(s.end_time)}`;

                if (s.category === 'lt' && s.lt_talks && s.lt_talks.length) {
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
                    if (s.category !== 'general') md += ` / ${CATEGORY_LABELS[s.category] || s.category}`;
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

        // --- Settings ---
        const appTitle = ref('カンファレンス スケジューラー');
        const settingsForm = reactive({ app_title: '' });
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
            } catch (e) { /* ignore */ }
        }
        async function saveSettings() {
            settingsMsg.value = '';
            try {
                await fetch(API + '/api/settings/', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ app_title: settingsForm.app_title })
                });
                appTitle.value = settingsForm.app_title;
                document.title = settingsForm.app_title;
                settingsMsg.value = '保存しました';
            } catch (e) { settingsMsg.value = '保存に失敗しました'; }
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
                if (data.status === 'ok') {
                    pwMsg.value = data.message;
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
                const data = await res.json();
                if (res.ok) {
                    ioMsg.value = `インポート完了: 部屋 ${data.rooms}件, セッション ${data.sessions}件, スタッフ ${data.staffs}件, 配置 ${data.assignments}件`;
                    ioMsgError.value = false;
                    backupFile.value = null;
                    backupFileName.value = '';
                    await loadRooms(); await loadSessions(); await loadStaffs(); await loadSchedule();
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
                const data = await res.json();
                if (res.ok) {
                    resetMsg.value = data.message || '全データを初期化しました';
                    resetMsgError.value = false;
                    resetPassword.value = '';
                    rooms.value = [];
                    sessions.value = [];
                    staffs.value = [];
                    schedule.value = [];
                    staffAssignments.value = [];
                    venueMaps.value = [];
                } else {
                    resetMsg.value = data.detail || '初期化に失敗しました';
                    resetMsgError.value = true;
                }
            } catch (e) {
                resetMsg.value = '初期化に失敗しました: ' + e.message;
                resetMsgError.value = true;
            }
        }

        async function switchTab(name) {
            tab.value = name;
            if (name === 'rooms') await loadRooms();
            if (name === 'venue-maps') await loadVenueMaps();
            if (name === 'sessions') { await loadRooms(); await loadSessions(); }
            if (name === 'staffs') { await loadSessions(); await loadStaffs(); await loadSchedule(); }
            if (name === 'matrix') { await loadStaffs(); await loadSchedule(); await loadStaffAssignments(); }
            if (name === 'all-matrix') { await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule(); }
            if (name === 'staff-detail') { await loadStaffs(); await loadSessions(); await loadSchedule(); await loadStaffAssignments(); }
            if (name === 'overall-manage') { await loadSessions(); }
            if (name === 'reception-manage') { await loadRooms(); await loadSessions(); await loadSchedule(); if (!rcForm.room_id && rooms.value.length) rcForm.room_id = rooms.value[0].id; }
            if (name === 'social-manage') { await loadRooms(); await loadSessions(); await loadSchedule(); if (!scForm.room_id && rooms.value.length) scForm.room_id = rooms.value[0].id; }
            if (name === 'reception') { await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule(); if (!rcForm.room_id && rooms.value.length) rcForm.room_id = rooms.value[0].id; }
            if (name === 'social') { await loadRooms(); await loadStaffs(); await loadSessions(); await loadSchedule(); if (!scForm.room_id && rooms.value.length) scForm.room_id = rooms.value[0].id; }
            if (name === 'venue-view') await loadVenueMaps();
            if (name === 'io') { await loadRooms(); await loadSessions(); }
        }

        // --- 部屋 ---
        function cancelEditRoom() {
            Object.assign(roomForm, { editId: null, name: '', capacity: null, floor: 1 });
        }
        function editRoom(r) {
            Object.assign(roomForm, { editId: r.id, name: r.name, capacity: r.capacity, floor: r.floor });
        }
        async function submitRoom() {
            const payload = { name: roomForm.name, capacity: roomForm.capacity, floor: roomForm.floor };
            if (roomForm.editId) {
                await fetch(API + `/api/rooms/${roomForm.editId}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                await fetch(API + '/api/rooms/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }
            cancelEditRoom();
            await loadRooms();
        }
        async function deleteRoom(id) { await fetch(API + `/api/rooms/${id}`, { method: 'DELETE' }); await loadRooms(); }

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
            if (venueMapForm.editId) {
                await fetch(API + `/api/venue-maps/${venueMapForm.editId}`, { method: 'PUT', body: fd });
            } else {
                await fetch(API + '/api/venue-maps/', { method: 'POST', body: fd });
            }
            cancelEditVenueMap();
            await loadVenueMaps();
        }
        async function deleteVenueMap(id) { await fetch(API + `/api/venue-maps/${id}`, { method: 'DELETE' }); await loadVenueMaps(); }

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
        function onPhotoChange(e) {
            const file = e.target.files[0];
            sessPhotoPreview.value = file ? URL.createObjectURL(file) : '';
        }
        function addLTTalk() {
            ltTalks.push({ title: '', speaker: '', speaker_kana: '', speaker_org: '', speaker_title: '' });
        }
        function cancelEditSession() {
            Object.assign(sessForm, {
                editId: null, title: '', speaker: '', speaker_kana: '', start_time: '', end_time: '',
                room_id: rooms.value.length ? rooms.value[0].id : null,
                category: 'general', required_staff: 1, english_required: false, description: '', notes: '', currentPhoto: '',
                speaker_org: '', speaker_title: '', speaker_profile: ''
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
                speaker_profile: s.speaker_profile || ''
            });
            ltTalks.splice(0);
            if (s.lt_talks && s.lt_talks.length) {
                s.lt_talks.forEach(t => ltTalks.push({
                    title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana || '',
                    speaker_org: t.speaker_org || '', speaker_title: t.speaker_title || ''
                }));
            }
            sessPhotoPreview.value = '';
            if (sessPhoto.value) sessPhoto.value.value = '';
        }
        async function submitSession() {
            const fd = new FormData();
            fd.append('title', sessForm.title);
            // LT/受付/懇親会の場合、speakerは自動設定
            if (sessForm.category === 'lt' && ltTalks.length) {
                fd.append('speaker', ltTalks.map(t => t.speaker).filter(Boolean).join(', '));
            } else if (['reception', 'social'].includes(sessForm.category)) {
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
            if (sessPhoto.value && sessPhoto.value.files[0]) fd.append('speaker_photo', sessPhoto.value.files[0]);

            let sessionId = sessForm.editId;
            if (sessionId) {
                await fetch(API + `/api/sessions/${sessionId}`, { method: 'PUT', body: fd });
            } else {
                const res = await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
                const created = await res.json();
                sessionId = created.id;
            }
            // LTトーク保存
            if (sessForm.category === 'lt' && ltTalks.length) {
                const talks = ltTalks.map((t, i) => ({
                    title: t.title, speaker: t.speaker, speaker_kana: t.speaker_kana,
                    speaker_org: t.speaker_org, speaker_title: t.speaker_title, order: i
                }));
                await fetch(API + `/api/sessions/${sessionId}/lt-talks`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(talks)
                });
            }
            cancelEditSession();
            await loadSessions();
        }
        async function deleteSession(id) { await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' }); await loadSessions(); }

        const calcStaffMsg = ref('');
        const calcStaffSummary = ref(null);
        async function calcRequiredStaff() {
            const data = await (await fetch(API + '/api/sessions/calc-required-staff', { method: 'POST' })).json();
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
            const payload = { name: staffForm.name, slack_name: staffForm.slack_name, role: staffForm.role, experience_count: staffForm.experience_count, english_ok: staffForm.english_ok };
            if (staffForm.editId) {
                await fetch(API + `/api/staffs/${staffForm.editId}`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                payload.availabilities = newStaffAvails.map(a => ({ start_time: a.start_time, end_time: a.end_time }));
                payload.preferred_sessions = newStaffPrefs.map(p => ({ session_id: p.session_id, priority: p.priority }));
                await fetch(API + '/api/staffs/', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }
            cancelEditStaff();
            await loadStaffs();
        }
        function editStaff(s) {
            staffForm.editId = s.id;
            staffForm.name = s.name;
            staffForm.slack_name = s.slack_name || '';
            staffForm.role = s.role || 'session';
            staffForm.experience_count = s.experience_count;
            staffForm.english_ok = !!s.english_ok;
        }
        function cancelEditStaff() {
            Object.assign(staffForm, { editId: null, name: '', slack_name: '', role: 'session', experience_count: 0, english_ok: false });
            newStaffAvails.splice(0);
            newAvailForm.start = '';
            newAvailForm.end = '';
            newStaffPrefs.splice(0);
            newPrefForm.session_id = null;
            newPrefForm.priority = 1;
        }
        async function deleteStaff(id) { await fetch(API + `/api/staffs/${id}`, { method: 'DELETE' }); await loadStaffs(); }
        async function uploadStaffPhoto(staffId, event) {
            const file = event.target.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('photo', file);
            const res = await fetch(API + `/api/staffs/${staffId}/photo`, { method: 'POST', body: fd });
            if (res.ok) { await loadStaffs(); } else { alert('写真のアップロードに失敗しました'); }
            event.target.value = '';
        }
        async function addPref(staffId) {
            const f = prefForms[staffId];
            await fetch(API + `/api/staffs/${staffId}/preferred-sessions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: f.session_id, priority: f.priority })
            });
            await loadStaffs();
        }
        async function removePref(staffId, prefId) {
            await fetch(API + `/api/staffs/${staffId}/preferred-sessions/${prefId}`, { method: 'DELETE' }); await loadStaffs();
        }
        async function addAvail(staffId) {
            const f = availForms[staffId];
            if (!f.start || !f.end) return;
            await fetch(API + `/api/staffs/${staffId}/availabilities`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ start_time: f.start + ':00', end_time: f.end + ':00' })
            });
            await loadStaffs();
        }
        async function removeAvail(staffId, availId) {
            await fetch(API + `/api/staffs/${staffId}/availabilities/${availId}`, { method: 'DELETE' }); await loadStaffs();
        }

        // --- スケジュール (手動配置) ---
        const sessionSchedule = computed(() => {
            return schedule.value.filter(e => !['reception', 'social', 'overall'].includes(e.session.category));
        });
        const receptionSessions = computed(() => {
            return schedule.value.filter(e => e.session.category === 'reception');
        });
        const socialSessions = computed(() => {
            return schedule.value.filter(e => e.session.category === 'social');
        });

        function _hasStaff(entry, staffId) {
            if (!staffId) return true;
            return entry.assigned_staff.some(a => a.staff.id === staffId);
        }
        // プルダウン用: 各タブに関連するスタッフ一覧
        const matrixStaffOptions = computed(() => staffs.value);
        const rcStaffOptions = computed(() => staffs.value);
        const scStaffOptions = computed(() => staffs.value);

        const filteredMatrixSchedule = computed(() => {
            if (!matrixStaffFilter.value) return sessionSchedule.value;
            return sessionSchedule.value.filter(e => _hasStaff(e, matrixStaffFilter.value));
        });
        const filteredReceptionSessions = computed(() => {
            if (!rcStaffFilter.value) return receptionSessions.value;
            return receptionSessions.value.filter(e => _hasStaff(e, rcStaffFilter.value));
        });
        const filteredSocialSessions = computed(() => {
            if (!scStaffFilter.value) return socialSessions.value;
            return socialSessions.value.filter(e => _hasStaff(e, scStaffFilter.value));
        });
        function matrixSessionOpacity(entry) {
            if (!matrixStaffFilter.value) return 1;
            return _hasStaff(entry, matrixStaffFilter.value) ? 1 : 0.15;
        }
        function rcSessionOpacity(entry) {
            if (!rcStaffFilter.value) return 1;
            return _hasStaff(entry, rcStaffFilter.value) ? 1 : 0.15;
        }
        function scSessionOpacity(entry) {
            if (!scStaffFilter.value) return 1;
            return _hasStaff(entry, scStaffFilter.value) ? 1 : 0.15;
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
                if (s.role !== targetRole) return false;
                // 時間重複チェック
                const busy = staffBusyMap[s.id] || [];
                for (const b of busy) {
                    if (sessStart < b.end && sessEnd > b.start) return false;
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
            await fetch(API + `/api/assignments/${assignmentId}`, { method: 'DELETE' });
            await loadSchedule();
        }

        async function autoAssign() {
            if (!confirm('スタッフを自動配置します。現在の配置はすべて上書きされます。よろしいですか？')) return;
            const ids = sessionSchedule.value.map(e => e.session.id);
            const data = await (await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
            })).json();
            scheduleMsg.value = { type: 'success', text: `配置完了: ${data.fully_assigned}/${data.total_sessions} セッション` };
            scheduleMsgError.value = data.understaffed && data.understaffed.length
                ? '人員不足: ' + data.understaffed.map(u => u.session_title).join(', ') : '';
            selectedSessions.clear();
            await loadSchedule();
        }
        async function autoAssignSelected() {
            const ids = [...selectedSessions];
            if (!confirm(`選択した${ids.length}件のセッションを再配置します。よろしいですか？`)) return;
            const data = await (await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
            })).json();
            scheduleMsg.value = { type: 'success', text: `再配置完了: ${data.fully_assigned}/${data.total_sessions} セッション` };
            scheduleMsgError.value = data.understaffed && data.understaffed.length
                ? '人員不足: ' + data.understaffed.map(u => u.session_title).join(', ') : '';
            selectedSessions.clear();
            await loadSchedule();
        }
        async function clearAssignments() {
            if (!confirm('セッション担当の配置をすべてクリアします。よろしいですか？')) return;
            const ids = sessionSchedule.value.flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            for (const id of ids) await fetch(API + `/api/assignments/${id}`, { method: 'DELETE' });
            scheduleMsg.value = { type: 'success', text: 'セッション担当の配置をクリアしました' };
            scheduleMsgError.value = '';
            await loadSchedule();
        }

        // ====================================================================
        //  受付管理
        // ====================================================================
        const rcForm = reactive({
            editId: null, title: '', start_time: '', end_time: '',
            room_id: null, required_staff: 2, english_required: false, notes: ''
        });
        const rcAssignMsg = ref('');

        function cancelEditReception() {
            Object.assign(rcForm, {
                editId: null, title: '', start_time: '', end_time: '',
                room_id: rooms.value.length ? rooms.value[0].id : null,
                required_staff: 2, english_required: false, notes: ''
            });
        }
        function editReception(s) {
            Object.assign(rcForm, {
                editId: s.id, title: s.title,
                start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                room_id: s.room_id, required_staff: s.required_staff,
                english_required: !!s.english_required, notes: s.notes || ''
            });
        }
        async function submitReception() {
            const fd = new FormData();
            fd.append('title', rcForm.title);
            fd.append('speaker', '-');
            const st = rcForm.start_time; const et = rcForm.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', rcForm.room_id);
            fd.append('category', 'reception');
            fd.append('required_staff', rcForm.required_staff);
            fd.append('english_required', rcForm.english_required);
            fd.append('notes', rcForm.notes);
            fd.append('description', '');
            fd.append('speaker_kana', '');
            fd.append('speaker_org', '');
            fd.append('speaker_title', '');
            fd.append('speaker_profile', '');
            if (rcForm.editId) {
                await fetch(API + `/api/sessions/${rcForm.editId}`, { method: 'PUT', body: fd });
            } else {
                await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
            }
            cancelEditReception();
            await loadSessions();
            await loadSchedule();
        }
        async function deleteReception(id) {
            if (!confirm('この受付案内を削除します。よろしいですか？')) return;
            await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            await loadSessions();
            await loadSchedule();
        }
        async function autoAssignReception() {
            if (!confirm('受付案内スタッフを自動配置します。現在の受付案内配置は上書きされます。よろしいですか？')) return;
            const ids = receptionSessions.value.map(e => e.session.id);
            const data = await (await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
            })).json();
            rcAssignMsg.value = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            await loadSchedule();
        }
        async function clearReceptionAssignments() {
            if (!confirm('受付案内のスタッフ配置をすべてクリアします。よろしいですか？')) return;
            const ids = receptionSessions.value.flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            for (const id of ids) await fetch(API + `/api/assignments/${id}`, { method: 'DELETE' });
            rcAssignMsg.value = '受付案内の配置をクリアしました';
            await loadSchedule();
        }

        // ====================================================================
        //  懇親会管理
        // ====================================================================
        const scForm = reactive({
            editId: null, title: '', start_time: '', end_time: '',
            room_id: null, required_staff: 2, english_required: false, notes: ''
        });
        const scAssignMsg = ref('');

        function cancelEditSocial() {
            Object.assign(scForm, {
                editId: null, title: '', start_time: '', end_time: '',
                room_id: rooms.value.length ? rooms.value[0].id : null,
                required_staff: 2, english_required: false, notes: ''
            });
        }
        function editSocial(s) {
            Object.assign(scForm, {
                editId: s.id, title: s.title,
                start_time: toLocalInput(s.start_time), end_time: toLocalInput(s.end_time),
                room_id: s.room_id, required_staff: s.required_staff,
                english_required: !!s.english_required, notes: s.notes || ''
            });
        }
        async function submitSocial() {
            const fd = new FormData();
            fd.append('title', scForm.title);
            fd.append('speaker', '-');
            const st = scForm.start_time; const et = scForm.end_time;
            fd.append('start_time', st.length === 16 ? st + ':00' : st);
            fd.append('end_time', et.length === 16 ? et + ':00' : et);
            fd.append('room_id', scForm.room_id);
            fd.append('category', 'social');
            fd.append('required_staff', scForm.required_staff);
            fd.append('english_required', scForm.english_required);
            fd.append('notes', scForm.notes);
            fd.append('description', '');
            fd.append('speaker_kana', '');
            fd.append('speaker_org', '');
            fd.append('speaker_title', '');
            fd.append('speaker_profile', '');
            if (scForm.editId) {
                await fetch(API + `/api/sessions/${scForm.editId}`, { method: 'PUT', body: fd });
            } else {
                await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
            }
            cancelEditSocial();
            await loadSessions();
            await loadSchedule();
        }
        async function deleteSocial(id) {
            if (!confirm('この役割を削除します。よろしいですか？')) return;
            await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            await loadSessions();
            await loadSchedule();
        }
        async function autoAssignSocial() {
            if (!confirm('懇親会スタッフを自動配置します。現在の懇親会配置は上書きされます。よろしいですか？')) return;
            const ids = socialSessions.value.map(e => e.session.id);
            const data = await (await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
            })).json();
            scAssignMsg.value = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            await loadSchedule();
        }
        async function clearSocialAssignments() {
            if (!confirm('懇親会のスタッフ配置をすべてクリアします。よろしいですか？')) return;
            const ids = socialSessions.value.flatMap(e => e.assigned_staff.map(a => a.assignment_id));
            for (const id of ids) await fetch(API + `/api/assignments/${id}`, { method: 'DELETE' });
            scAssignMsg.value = '懇親会の配置をクリアしました';
            await loadSchedule();
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
        const tlRooms = computed(() => {
            const map = new Map();
            sessionSchedule.value.forEach(e => {
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });

        // グリッドスタイル
        const tlGridStyle = computed(() => {
            const cfg = tlConfig.value;
            if (!cfg) return {};
            return {
                gridTemplateColumns: `70px repeat(${tlRooms.value.length}, 1fr)`,
                gridTemplateRows: `auto repeat(${cfg.totalSlots}, 20px)`,
            };
        });

        // 時間 → グリッド行番号
        function timeToRow(dt) {
            const cfg = tlConfig.value;
            const t = new Date(dt).getTime();
            return Math.round((t - cfg.minTime) / cfg.slotMs) + 2; // +2: header(1) + 1-based
        }

        // 15分ごとの時間ラベル + 背景セル
        const tlLabels = computed(() => {
            const cfg = tlConfig.value;
            if (!cfg) return [];
            const labels = [];
            const slotsPerLabel = 15 / SLOT_MIN; // 3スロット = 15分
            const labelCount = cfg.totalSlots / slotsPerLabel;
            for (let i = 0; i < labelCount; i++) {
                const t = new Date(cfg.minTime + i * slotsPerLabel * cfg.slotMs);
                const mins = t.getMinutes();
                labels.push({
                    text: (mins === 0 || mins === 30)
                        ? t.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })
                        : '',
                    gridRow: i * slotsPerLabel + 2,
                    span: slotsPerLabel,
                    isHour: mins === 0,
                    isHalf: mins === 30,
                    isQuarter: mins === 15 || mins === 45,
                });
            }
            return labels;
        });

        // セッションのグリッドスタイル
        function tlSessionStyle(entry) {
            const startRow = timeToRow(entry.session.start_time);
            const endRow = timeToRow(entry.session.end_time);
            const ci = tlRooms.value.findIndex(([rid]) => rid === entry.session.room_id);
            return {
                gridRow: `${startRow} / ${endRow}`,
                gridColumn: `${ci + 2}`,
            };
        }

        // ====================================================================
        //  ドラッグ & ドロップ（Googleカレンダー風）
        // ====================================================================
        const DRAG_THRESHOLD = 10; // px — 明確なドラッグ意図が必要

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
            if (e.button !== 0) return;
            if (matrixLocked.value) return;
            e.preventDefault();

            const sessionEl = e.currentTarget;
            const rect = sessionEl.getBoundingClientRect();
            const edgeThreshold = 8;
            const relY = e.clientY - rect.top;

            let mode = 'move';
            if (relY <= edgeThreshold) mode = 'resize-top';
            else if (rect.bottom - e.clientY <= edgeThreshold) mode = 'resize-bottom';

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
            drag.startMouseY = e.clientY;
            drag.startMouseX = e.clientX;
            drag.gridEl = gridEl;
            drag.colWidths = colBounds;

            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        }

        function onDragMove(e) {
            if (!drag.pending && !drag.active) return;

            const dx = e.clientX - drag.startMouseX;
            const dy = e.clientY - drag.startMouseY;
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
                // 行の範囲チェック（row 2 が最初のデータ行）
                if (newStart >= 2) {
                    drag.curStartRow = newStart;
                    drag.curEndRow = newStart + span;
                }
                // 列はマウスX位置から判定
                drag.curColIdx = _colFromMouseX(e.clientX, drag.gridEl, drag.colWidths);
            } else if (drag.mode === 'resize-top') {
                const newStart = drag.origStartRow + rowDelta;
                if (newStart >= 2 && newStart < drag.origEndRow - 1) {
                    drag.curStartRow = newStart;
                }
                // リサイズ時は列を変えない
            } else if (drag.mode === 'resize-bottom') {
                const newEnd = drag.origEndRow + rowDelta;
                if (newEnd > drag.origStartRow + 1) {
                    drag.curEndRow = newEnd;
                }
                // リサイズ時は列を変えない
            }
        }

        async function onDragEnd() {
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);

            // 閾値未到達 = 単なるクリック → 何もしない
            if (!drag.active) {
                drag.pending = false;
                drag.sessionId = null;
                return;
            }

            const changed = drag.curStartRow !== drag.origStartRow
                         || drag.curEndRow !== drag.origEndRow
                         || drag.curColIdx !== drag.origColIdx;

            if (changed) {
                const cfg = tlConfig.value;
                const newStartMs = cfg.minTime + (drag.curStartRow - 2) * cfg.slotMs;
                const newEndMs = cfg.minTime + (drag.curEndRow - 2) * cfg.slotMs;
                const newRoomId = tlRooms.value[drag.curColIdx]?.[0];

                if (!newRoomId || newStartMs >= newEndMs) {
                    // 無効な移動先 — 元に戻す
                    drag.active = false;
                    drag.pending = false;
                    drag.sessionId = null;
                    return;
                }

                function toISO(ms) {
                    const d = new Date(ms);
                    const pad = (n) => String(n).padStart(2, '0');
                    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
                }

                try {
                    const resp = await fetch(API + `/api/sessions/${drag.sessionId}/move`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            start_time: toISO(newStartMs),
                            end_time: toISO(newEndMs),
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


        // ===== 受付マトリクス =====
        const rcConfig = computed(() => {
            if (!receptionSessions.value.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            let minT = Infinity, maxT = -Infinity;
            receptionSessions.value.forEach(e => {
                const s = new Date(e.session.start_time).getTime();
                const end = new Date(e.session.end_time).getTime();
                if (s < minT) minT = s;
                if (end > maxT) maxT = end;
            });
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        });
        const rcRooms = computed(() => {
            const map = new Map();
            receptionSessions.value.forEach(e => {
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        const rcGridStyle = computed(() => {
            const cfg = rcConfig.value;
            if (!cfg) return {};
            return {
                gridTemplateColumns: `70px repeat(${rcRooms.value.length}, 1fr)`,
                gridTemplateRows: `auto repeat(${cfg.totalSlots}, 20px)`,
            };
        });
        function rcTimeToRow(dt) {
            const cfg = rcConfig.value;
            const t = new Date(dt).getTime();
            return Math.round((t - cfg.minTime) / cfg.slotMs) + 2;
        }
        const rcLabels = computed(() => {
            const cfg = rcConfig.value;
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
        function rcSessionStyle(entry) {
            const startRow = rcTimeToRow(entry.session.start_time);
            const endRow = rcTimeToRow(entry.session.end_time);
            const ci = rcRooms.value.findIndex(([rid]) => rid === entry.session.room_id);
            return { gridRow: `${startRow} / ${endRow}`, gridColumn: `${ci + 2}` };
        }
        const rcSelectedSession = ref(null);
        const rcSelectedEntry = computed(() => {
            if (!rcSelectedSession.value) return null;
            return receptionSessions.value.find(e => e.session.id === rcSelectedSession.value) || null;
        });

        // --- 懇親会マトリクス ---
        const scConfig = computed(() => {
            if (!socialSessions.value.length) return null;
            const slotMs = SLOT_MIN * 60 * 1000;
            let minT = Infinity, maxT = -Infinity;
            socialSessions.value.forEach(e => {
                const s = new Date(e.session.start_time).getTime();
                const end = new Date(e.session.end_time).getTime();
                if (s < minT) minT = s;
                if (end > maxT) maxT = end;
            });
            minT = Math.floor(minT / slotMs) * slotMs;
            maxT = Math.ceil(maxT / slotMs) * slotMs;
            return { minTime: minT, maxTime: maxT, totalSlots: (maxT - minT) / slotMs, slotMs };
        });
        const scRooms = computed(() => {
            const map = new Map();
            socialSessions.value.forEach(e => {
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        const scGridStyle = computed(() => {
            const cfg = scConfig.value;
            if (!cfg) return {};
            return {
                gridTemplateColumns: `70px repeat(${scRooms.value.length}, 1fr)`,
                gridTemplateRows: `auto repeat(${cfg.totalSlots}, 20px)`,
            };
        });
        function scTimeToRow(dt) {
            const cfg = scConfig.value;
            const t = new Date(dt).getTime();
            return Math.round((t - cfg.minTime) / cfg.slotMs) + 2;
        }
        const scLabels = computed(() => {
            const cfg = scConfig.value;
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
        function scSessionStyle(entry) {
            const startRow = scTimeToRow(entry.session.start_time);
            const endRow = scTimeToRow(entry.session.end_time);
            const ci = scRooms.value.findIndex(([rid]) => rid === entry.session.room_id);
            return { gridRow: `${startRow} / ${endRow}`, gridColumn: `${ci + 2}` };
        }
        const scSelectedSession = ref(null);
        const scSelectedEntry = computed(() => {
            if (!scSelectedSession.value) return null;
            return socialSessions.value.find(e => e.session.id === scSelectedSession.value) || null;
        });

        // --- 全体スケジュール ---
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
            if (allOvForm.editId) {
                await fetch(API + `/api/sessions/${allOvForm.editId}`, { method: 'PUT', body: fd });
            } else {
                await fetch(API + '/api/sessions/', { method: 'POST', body: fd });
            }
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
            const labels = { reception: '受付案内', social: '懇親会', overall: '全体スケジュール' };
            const label = labels[category] || 'この項目';
            if (!confirm(`この${label}を削除します。よろしいですか？`)) return;
            allSelectedSession.value = null;
            await fetch(API + `/api/sessions/${id}`, { method: 'DELETE' });
            await loadSessions(); await loadSchedule();
        }

        async function autoAssignAll() {
            if (!confirm('全体を自動配置します。現在の配置は上書きされます。よろしいですか？')) return;
            const ids = allSchedule.value.map(e => e.session.id);
            const data = await (await fetch(API + '/api/assignments/auto-assign', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_ids: ids })
            })).json();
            allAssignMsg.value = `配置完了: ${data.fully_assigned}/${data.total_sessions} 件`;
            await loadSchedule();
        }
        const overallSessions = computed(() =>
            sessions.value.filter(s => s.category === 'overall').sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
        );
        const allSchedule = computed(() => schedule.value);
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
        // 全体スケジュール（overall）があるか
        const hasOverall = computed(() => allSchedule.value.some(e => e.session.category === 'overall'));
        // セッション用の部屋（reception/social/overall除外）
        const allSessionRooms = computed(() => {
            const map = new Map();
            allSchedule.value.forEach(e => {
                if (['reception', 'social', 'overall'].includes(e.session.category)) return;
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        // 受付用の列（受付セッションのタイトルごと or 部屋ごと）
        const allReceptionCols = computed(() => {
            const map = new Map();
            allSchedule.value.forEach(e => {
                if (e.session.category !== 'reception') return;
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        // 懇親会用の列
        const allSocialCols = computed(() => {
            const map = new Map();
            allSchedule.value.forEach(e => {
                if (e.session.category !== 'social') return;
                const r = e.session.room;
                if (r && !map.has(r.id)) map.set(r.id, r.name);
            });
            return [...map.entries()].sort((a, b) => a[0] - b[0]);
        });
        // 全列 = 全体 + セッション部屋 + 受付列 + 懇親会列
        const allColumns = computed(() => {
            const cols = [];
            if (hasOverall.value) cols.push({ id: 'overall', name: '全体', type: 'overall' });
            allSessionRooms.value.forEach(([id, name]) => cols.push({ id, name, type: 'session' }));
            allReceptionCols.value.forEach(([id, name]) => cols.push({ id, name: '受付案内: ' + name, type: 'reception', roomId: id }));
            allSocialCols.value.forEach(([id, name]) => cols.push({ id: 's_' + id, name: '懇親会: ' + name, type: 'social', roomId: id }));
            return cols;
        });
        const allGridStyle = computed(() => {
            const cfg = allConfig.value;
            if (!cfg) return {};
            const ovCount = hasOverall.value ? 1 : 0;
            const sessionCount = allSessionRooms.value.length;
            const rcCount = allReceptionCols.value.length;
            const scCount = allSocialCols.value.length;
            const colWidths = [];
            if (ovCount) colWidths.push('1fr');
            if (sessionCount) colWidths.push(`repeat(${sessionCount}, 1fr)`);
            if (rcCount) colWidths.push(`repeat(${rcCount}, 1fr)`);
            if (scCount) colWidths.push(`repeat(${scCount}, 1fr)`);
            return {
                gridTemplateColumns: `70px ${colWidths.join(' ')}`,
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
            const ovOffset = hasOverall.value ? 1 : 0;
            let ci;
            if (cat === 'overall') {
                ci = 0;
            } else if (cat === 'reception') {
                ci = ovOffset + allSessionRooms.value.length + allReceptionCols.value.findIndex(([rid]) => rid === entry.session.room_id);
            } else if (cat === 'social') {
                ci = ovOffset + allSessionRooms.value.length + allReceptionCols.value.length + allSocialCols.value.findIndex(([rid]) => rid === entry.session.room_id);
            } else {
                ci = ovOffset + allSessionRooms.value.findIndex(([rid]) => rid === entry.session.room_id);
            }
            return { gridRow: `${startRow} / ${endRow}`, gridColumn: `${ci + 2}` };
        }
        const CAT_COLORS = {
            general: 'background:linear-gradient(135deg,#e8f0fe,#d2e3fc);border-color:#1a73e8',
            tech: 'background:linear-gradient(135deg,#e8f0fe,#d2e3fc);border-color:#1a73e8',
            workshop: 'background:linear-gradient(135deg,#e8f0fe,#d2e3fc);border-color:#1a73e8',
            keynote: 'background:linear-gradient(135deg,#e8f0fe,#d2e3fc);border-color:#1a73e8',
            lt: 'background:linear-gradient(135deg,#e8f0fe,#d2e3fc);border-color:#1a73e8',
            reception: 'background:linear-gradient(135deg,#e8f5e9,#c8e6c9);border-color:#388e3c',
            social: 'background:linear-gradient(135deg,#f3e5f5,#e1bee7);border-color:#7b1fa2',
        };
        const CAT_BG = {
            general: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
            tech: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
            workshop: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
            keynote: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
            lt: { background: 'linear-gradient(135deg,#e8f0fe,#d2e3fc)', borderColor: '#1a73e8' },
            reception: { background: 'linear-gradient(135deg,#e8f5e9,#c8e6c9)', borderColor: '#388e3c' },
            social: { background: 'linear-gradient(135deg,#f3e5f5,#e1bee7)', borderColor: '#7b1fa2' },
            overall: { background: 'linear-gradient(135deg,#fff3e0,#ffe0b2)', borderColor: '#e65100' },
        };
        function allSessionBg(cat) { return CAT_BG[cat] || CAT_BG.general; }
        function allSessionOpacity(entry) {
            if (!allStaffFilter.value) return 1;
            return _hasStaff(entry, allStaffFilter.value) ? 1 : 0.15;
        }

        onMounted(() => { loadRooms(); loadStaffs(); loadSessions().then(() => loadSchedule()); loadSettings(); });

        return {
            tab, rooms, sessions, staffs, schedule, staffAssignments,
            scheduleMsg, scheduleMsgError, sessPhotoPreview, sessPhoto,
            roomForm, sessForm, staffForm, prefForms, availForms, ltTalks,
            venueMaps, venueMapForm, venueMapPreview, venueMapInput, mapModal,
            switchTab, catLabel, fmt, fmtShort, sortedPrefs,
            cancelEditRoom, editRoom, submitRoom, deleteRoom,
            onVenueMapChange, cancelEditVenueMap, editVenueMap, submitVenueMap, deleteVenueMap,
            sessDetailSession, sessDetailEntry, sessDetailLocked, toggleSessionDetail,
            onPhotoChange, cancelEditSession, editSession, submitSession, deleteSession, addLTTalk,
            calcStaffMsg, calcStaffSummary, calcRequiredStaff,
            newStaffAvails, newAvailForm, addNewStaffAvail,
            newStaffPrefs, newPrefForm, addNewStaffPref, sessionTitle,
            staffAssignCount, editingStaffPrefs, editingStaffAvails,
            submitStaff, editStaff, cancelEditStaff, deleteStaff, uploadStaffPhoto, addPref, removePref, addAvail, removeAvail,
            sessionSchedule, receptionSessions, socialSessions,
            assignStaffSelect, availableStaffs, addAssignment, removeAssignment,
            selectedSessions, toggleSessionSelect, toggleSelectAll,
            autoAssign, autoAssignSelected, clearAssignments,
            tlRooms, tlGridStyle, tlLabels, tlSessionStyle, tlBreaks,
            matrixLocked, drag, dragSessionStyle, onDragStart, dragCursor,
            rcConfig, rcRooms, rcGridStyle, rcLabels, rcSessionStyle,
            rcSelectedSession, rcSelectedEntry,
            receptionLocked, rcForm, rcAssignMsg, cancelEditReception, editReception, submitReception, deleteReception, autoAssignReception, clearReceptionAssignments,
            socialLocked, scForm, scAssignMsg, cancelEditSocial, editSocial, submitSocial, deleteSocial, autoAssignSocial, clearSocialAssignments,
            scConfig, scRooms, scGridStyle, scLabels, scSessionStyle,
            scSelectedSession, scSelectedEntry,
            exportExcel, exportBackup, backupFileName, ioMsg, ioMsgError, onBackupFileChange, importBackup,
            connpassTimeline, speakerTemplate, connpassBaseUrl, generateConnpassTimeline, generateSpeakerTemplate, copyToClipboard,
            resetAllData, resetMsg, resetMsgError, resetPassword,
            appTitle, settingsForm, settingsMsg, saveSettings,
            pwForm, pwMsg, pwMsgError, changePassword,
            staffDetailFilter, matrixStaffFilter, rcStaffFilter, scStaffFilter,
            matrixStaffOptions, rcStaffOptions, scStaffOptions,
            overallSessions,
            allStaffFilter, allSchedule, allConfig, allColumns, allGridStyle, allLabels, allSessionStyle, allSessionBg, allSessionOpacity,
            allSelectedSession, allSelectedEntry, allAssignMsg,
            allOvForm, cancelAllOverall, submitAllOverall,
            editAllEntry, deleteAllEntry, autoAssignAll,
            filteredMatrixSchedule, filteredReceptionSessions, filteredSocialSessions,
            matrixSessionOpacity, rcSessionOpacity, scSessionOpacity, _hasStaff,
        };
    }
}).mount('#app');
