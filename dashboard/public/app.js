// flowabot dashboard frontend — no frameworks, no build step.
(function () {
    'use strict';

    var pollTimer = null;
    var guildsCache = null;
    var guildPage = {}; // guild_id -> { channel, expanded, events }

    var activityState = { guild: '', type: '', q: '', expanded: false };

    // ---------- helpers ----------

    function $(selector, root) { return (root || document).querySelector(selector); }
    function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function api(path, opts) {
        var res = await fetch(path, opts);

        // a 401 from anywhere but the login endpoint itself means the session expired
        if (res.status === 401 && path !== '/api/login') {
            showLogin();
            var err = new Error('Not logged in.');
            err.unauthorized = true;
            throw err;
        }

        var body = null;

        try { body = await res.json(); } catch (e) { /* no body */ }

        if (!res.ok)
            throw new Error(body && body.error ? body.error : 'Request failed (' + res.status + ')');

        return body;
    }

    function timeAgo(t) {
        var s = Math.floor((Date.now() - t) / 1000);

        if (s < 10) return 'just now';
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }

    function fullTime(t) {
        return new Date(t).toLocaleString();
    }

    function fmtUptime(seconds) {
        if (seconds == null) return '—';

        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);

        if (d > 0) return d + 'd ' + h + 'h';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm ' + Math.floor(seconds % 60) + 's';
    }

    function errorCard(message) {
        return '<div class="card"><div class="empty-state">Couldn\u2019t load: ' + esc(message) + '</div></div>';
    }

    function initial(name) {
        return name ? name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?' : '?';
    }

    // ---------- shell / auth ----------

    function showLogin() {
        $('#app-view').classList.add('hidden');
        $('#login-view').classList.remove('hidden');
        var input = $('#login-password');
        input.value = '';
        input.focus();
    }

    function showApp() {
        $('#login-view').classList.add('hidden');
        $('#app-view').classList.remove('hidden');
        refreshBotChip();

        if (!location.hash || location.hash === '#/')
            location.hash = '#/overview';
        else
            route();
    }

    async function refreshBotChip() {
        try {
            var status = await api('/api/status');

            if (status.bot.avatar)
                $('#bot-avatar').src = status.bot.avatar;

            $('#bot-tag').textContent = status.bot.tag || 'flowabot';

            var ping = status.ping;
            var dot = ping != null && ping < 500 ? 'ok' : 'warn';
            $('#bot-status').innerHTML =
                '<span class="status-dot ' + dot + '"></span>' +
                (ping != null ? Math.max(0, Math.round(ping)) + 'ms \u00b7 ' + status.guilds + ' servers'
                              : status.guilds + ' servers');
        } catch (err) {
            if (!err.unauthorized)
                $('#bot-status').textContent = 'status unavailable';
        }
    }

    async function tryLogin(event) {
        event.preventDefault();

        var button = $('#login-btn');
        var error = $('#login-error');
        button.disabled = true;
        error.textContent = '';

        try {
            await api('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: $('#login-password').value })
            });

            showApp();
        } catch (err) {
            error.textContent = err.message;
        } finally {
            button.disabled = false;
        }
    }

    async function logout() {
        try { await api('/api/logout', { method: 'POST' }); } catch (err) { /* ignore */ }
        showLogin();
    }

    // ---------- routing ----------

    function setActiveNav(view) {
        $$('#nav a').forEach(function (a) {
            a.classList.toggle('active', a.dataset.view === view);
        });
    }

    function route() {
        if ($('#app-view').classList.contains('hidden'))
            return;

        if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        var parts = (location.hash || '#/overview').slice(2).split('/');

        switch (parts[0]) {
            case 'servers': renderServers(); break;
            case 'guild': parts[1] ? renderGuild(parts[1]) : renderServers(); break;
            case 'activity': renderActivity(); break;
            case 'commands': renderCommands(); break;
            default: renderOverview();
        }
    }

    // ---------- overview ----------

    function statCardHtml(value, label) {
        return '<div class="card"><div class="stat-value">' + value + '</div>' +
            '<div class="stat-label">' + esc(label) + '</div></div>';
    }

    function barRowsHtml(rows, nameFormatter) {
        if (rows.length === 0)
            return '<div class="empty-state">No usage recorded yet.</div>';

        var max = rows[0].count != null ? rows[0].count : rows[0].total;

        return rows.map(function (row, i) {
            var count = row.count != null ? row.count : row.total;
            var width = max > 0 ? Math.max(3, Math.round(count / max * 100)) : 0;
            var name = nameFormatter(row);

            return '<div class="stat-row">' +
                '<span class="rank-num">' + (i + 1) + '</span>' +
                '<span class="stat-row-name">' + name + '</span>' +
                '<span class="stat-row-bar-wrap"><span class="stat-row-bar" style="width:' + width + '%"></span></span>' +
                '<span class="stat-row-count">' + count + '</span>' +
                '</div>';
        }).join('');
    }

    async function renderOverview() {
        setActiveNav('overview');

        var content = $('#content');
        content.innerHTML = '<h1 class="page-title">Overview</h1><p class="page-sub">Bot status and command usage</p><div id="overview-body">' +
            '<div class="empty-state">Loading\u2026</div></div>';

        var status, stats;

        try {
            var results = await Promise.all([api('/api/status'), api('/api/stats')]);
            status = results[0];
            stats = results[1];
        } catch (err) {
            if (err.unauthorized) return;
            $('#overview-body').innerHTML = errorCard(err.message);
            return;
        }

        $('#bot-status').innerHTML =
            '<span class="status-dot ' + (status.ping != null && status.ping < 500 ? 'ok' : 'warn') + '"></span>' +
            (status.ping != null ? Math.max(0, Math.round(status.ping)) + 'ms \u00b7 ' + status.guilds + ' servers'
                                 : status.guilds + ' servers');

        var html = '<div class="cards-grid">' +
            statCardHtml(fmtUptime(status.uptime_seconds), 'uptime') +
            statCardHtml(status.ping != null ? Math.max(0, Math.round(status.ping)) + '<small> ms</small>' : '—', 'gateway ping') +
            statCardHtml(String(status.guilds), 'servers') +
            statCardHtml(String(stats.total_commands), 'commands used') +
            statCardHtml(String(status.commands_available), 'commands available') +
            statCardHtml(String(status.tracked_users), 'tracked osu! users') +
            statCardHtml(status.memory.rss_mb + '<small> MB</small>', 'memory (rss)') +
            statCardHtml(status.started_at != null ? timeAgo(status.started_at) : '—', 'started ' + (status.started_at != null ? fullTime(status.started_at) : '')) +
            '</div>';

        html += '<div class="split-grid">' +
            '<div class="card"><div class="card-title">Top commands</div>' +
            barRowsHtml(stats.top_commands, function (row) { return '<code>' + esc(row.command) + '</code>'; }) +
            '</div>' +
            '<div class="card"><div class="card-title">Top users</div>' +
            barRowsHtml(stats.top_users, function (row) { return esc(row.name); }) +
            '</div>' +
            '</div>';

        $('#overview-body').innerHTML = html;
    }

    // ---------- servers ----------

    function guildIconHtml(guild, sizeClass) {
        if (guild.icon)
            return '<div class="guild-icon"><img src="' + esc(guild.icon) + '" alt=""></div>';

        return '<div class="guild-icon">' + esc(initial(guild.name)) + '</div>';
    }

    async function renderServers() {
        setActiveNav('servers');

        var content = $('#content');
        content.innerHTML = '<h1 class="page-title">Servers</h1>' +
            '<p class="page-sub">Servers the bot is in — click one to see its activity and send messages</p>' +
            '<div id="servers-body"><div class="empty-state">Loading\u2026</div></div>';

        var guilds, stats;

        try {
            var results = await Promise.all([api('/api/guilds'), api('/api/stats')]);
            guilds = results[0].guilds;
            stats = results[1];

            guildsCache = guilds;
        } catch (err) {
            if (err.unauthorized) return;
            $('#servers-body').innerHTML = errorCard(err.message);
            return;
        }

        var usageByGuild = {};
        stats.guild_usage.forEach(function (g) { usageByGuild[g.id] = g.count; });

        var maxUsage = stats.guild_usage.length > 0 ? stats.guild_usage[0].count : 0;

        var html = '<div class="guild-grid">';

        if (guilds.length === 0)
            html += '<div class="card"><div class="empty-state">The bot isn\u2019t in any server yet.</div></div>';

        guilds.forEach(function (guild) {
            var usage = usageByGuild[guild.id] || 0;
            var width = maxUsage > 0 ? Math.max(3, Math.round(usage / maxUsage * 100)) : 0;

            html += '<div class="guild-card" data-guild="' + esc(guild.id) + '">' +
                '<div class="guild-head">' + guildIconHtml(guild) +
                '<div><div class="guild-name">' + esc(guild.name) + '</div>' +
                '<div class="guild-members">' + (guild.member_count != null ? guild.member_count + ' members' : '') + '</div></div></div>' +
                '<div class="guild-usage-bar"><div style="width:' + width + '%"></div></div>' +
                '<div class="guild-usage-label">' + usage + ' commands used</div>' +
                '</div>';
        });

        html += '</div>';

        $('#servers-body').innerHTML = html;

        $$('.guild-card').forEach(function (card) {
            card.addEventListener('click', function () {
                location.hash = '#/guild/' + card.dataset.guild;
            });
        });
    }

    // ---------- activity feed ----------

    function eventDetailHtml(event) {
        if (event.type === 'dashboard')
            return '<span class="t-detail">sent: ' + esc(event.content) + '</span>';

        if (event.type === 'command')
            return '<span class="t-detail"><code>' + esc(event.content) + '</code></span>';

        return '<span class="t-detail">' + (event.content ? esc(event.content) : '<i style="color:var(--text-faint)">(no text)</i>') + '</span>';
    }

    function eventRowHtml(event, showGuild) {
        var where = '';

        if (showGuild)
            where = esc(event.guild_name || event.guild || '?') + ' \u00b7 ';

        where += '#' + esc(event.channel_name || event.channel || '?');

        return '<tr>' +
            '<td class="t-time" title="' + esc(fullTime(event.t)) + '">' + esc(timeAgo(event.t)) + '</td>' +
            '<td><span class="badge ' + esc(event.type) + '">' + esc(event.type) + '</span></td>' +
            (showGuild ? '<td class="t-where">' + where + '</td>' : '<td class="t-where">#' + esc(event.channel_name || event.channel || '?') + '</td>') +
            '<td class="t-user">' + esc(event.user_name || '?') + '</td>' +
            '<td>' + eventDetailHtml(event) + '</td>' +
            '</tr>';
    }

    function eventsTableHtml(events, showGuild, showEmpty) {
        if (events.length === 0)
            return showEmpty !== false ? '<div class="empty-state">No activity recorded yet.</div>' : '';

        return '<div class="table-wrap"><div class="table-scroll"><table><thead><tr>' +
            '<th>When</th><th>Type</th>' + (showGuild ? '<th>Where</th>' : '<th>Channel</th>') + '<th>User</th><th>Detail</th>' +
            '</tr></thead><tbody>' +
            events.map(function (event) { return eventRowHtml(event, showGuild); }).join('') +
            '</tbody></table></div></div>';
    }

    function activityQuery(state, before, limit) {
        var params = new URLSearchParams();

        if (state.guild) params.set('guild', state.guild);
        if (state.type) params.set('type', state.type);
        if (state.q) params.set('q', state.q);
        if (before) params.set('before', before);
        params.set('limit', String(limit || 50));

        return '/api/activity?' + params.toString();
    }

    async function fetchGuildActivity(guildId, state, before) {
        var params = new URLSearchParams();

        params.set('guild', guildId);
        if (state.type) params.set('type', state.type);
        if (state.q) params.set('q', state.q);
        if (before) params.set('before', before);
        params.set('limit', '50');

        var result = await api('/api/activity?' + params.toString());
        return result.events;
    }

    // ---------- guild detail ----------

    async function renderGuild(guildId) {
        setActiveNav('servers');

        var content = $('#content');
        content.innerHTML = '<a class="back-link" href="#/servers">\u2190 All servers</a><div id="guild-body">' +
            '<div class="empty-state">Loading\u2026</div></div>';

        var guild, events, state;

        try {
            guild = await api('/api/guilds/' + encodeURIComponent(guildId));

            state = guildPage[guildId];

            if (!state) {
                state = guildPage[guildId] = { channel: null, expanded: false, events: [], type: '', q: '' };
            }

            events = await fetchGuildActivity(guildId, state, null);
            state.events = events;
        } catch (err) {
            if (err.unauthorized) return;
            $('#guild-body').innerHTML = errorCard(err.message);
            return;
        }

        // default composer channel: first sendable
        if (state.channel == null) {
            outer:
            for (var g = 0; g < guild.channels.length; g++) {
                for (var c = 0; c < guild.channels[g].channels.length; c++) {
                    if (guild.channels[g].channels[c].can_send) {
                        state.channel = guild.channels[g].channels[c].id;
                        break outer;
                    }
                }
            }
        }

        var channelsHtml = '';

        guild.channels.forEach(function (group) {
            channelsHtml += '<div class="channel-group-title">' + esc(group.name) + '</div>';

            group.channels.forEach(function (channel) {
                channelsHtml += '<div class="channel-item' + (channel.can_send ? '' : ' no-send') +
                    (channel.id === state.channel ? ' selected' : '') + '" data-channel="' + esc(channel.id) + '"' +
                    (channel.can_send ? '' : ' title="bot can\u2019t send here"') + '>' +
                    '<span class="hash">#</span>' + esc(channel.name) + '</div>';
            });
        });

        if (channelsHtml === '')
            channelsHtml = '<div class="empty-state">No text channels found.</div>';

        var composerTarget = '\u2014';

        guild.channels.forEach(function (group) {
            group.channels.forEach(function (channel) {
                if (channel.id === state.channel)
                    composerTarget = '#' + channel.name;
            });
        });

        var html = '<div class="guild-head-card">' + guildIconHtml(guild) +
            '<div><div class="guild-name" style="font-size:17px">' + esc(guild.name) + '</div>' +
            '<div class="guild-members">' + (guild.member_count != null ? guild.member_count + ' members \u00b7 ' : '') +
            'id ' + esc(guild.id) + '</div></div></div>';

        html += '<div class="guild-layout">' +
            '<div class="card"><div class="card-title">Channels</div>' + channelsHtml + '</div>' +
            '<div>' +
            '<div class="card composer" style="margin-bottom:14px">' +
            '<div class="card-title">Send as bot</div>' +
            '<div class="composer-target">to <code id="composer-target-name">' + esc(composerTarget) + '</code></div>' +
            '<textarea id="composer-text" maxlength="2000" placeholder="Message to send as ' + esc(guild.name || 'the bot') + '\u2019s bot\u2026 (markdown works)"></textarea>' +
            '<div class="composer-row">' +
            '<button id="send-btn">Send</button>' +
            '<span class="char-count" id="char-count">0 / 2000</span>' +
            '</div>' +
            '<div class="composer-error" id="composer-error"></div>' +
            '</div>' +
            '<div class="card" style="padding:0;overflow:hidden;background:transparent;border:none">' +
            '<div class="filter-bar">' +
            '<select id="guild-type-filter">' +
            '<option value="">All types</option>' +
            '<option value="command"' + (state.type === 'command' ? ' selected' : '') + '>Commands</option>' +
            '<option value="message"' + (state.type === 'message' ? ' selected' : '') + '>Messages</option>' +
            '<option value="dashboard"' + (state.type === 'dashboard' ? ' selected' : '') + '>Dashboard</option>' +
            '</select>' +
            '<input type="text" id="guild-search" placeholder="Search user or content\u2026" value="' + esc(state.q) + '">' +
            '<span class="live-badge"><span class="live-dot"></span>live</span>' +
            '</div>' +
            '<div id="guild-activity-list"></div>' +
            '</div>' +
            '</div></div>';

        $('#guild-body').innerHTML = html;

        // wire channel selection
        $$('#guild-body .channel-item').forEach(function (item) {
            item.addEventListener('click', function () {
                if (item.classList.contains('no-send'))
                    return;

                state.channel = item.dataset.channel;
                $$('#guild-body .channel-item').forEach(function (other) { other.classList.remove('selected'); });
                item.classList.add('selected');
                $('#composer-target-name').textContent = '#' + item.textContent.replace(/^#/, '');
            });
        });

        // composer
        var textarea = $('#composer-text');
        var charCount = $('#char-count');
        var sendBtn = $('#send-btn');
        var composerError = $('#composer-error');

        textarea.addEventListener('input', function () {
            charCount.textContent = textarea.value.length + ' / 2000';
            charCount.classList.toggle('over', textarea.value.length > 2000);
        });

        var armTimer = null;

        function disarm() {
            sendBtn.classList.remove('armed');
            sendBtn.textContent = 'Send';
            if (armTimer != null) {
                clearTimeout(armTimer);
                armTimer = null;
            }
        }

        sendBtn.addEventListener('click', async function () {
            var content = textarea.value;

            composerError.textContent = '';
            composerError.classList.remove('composer-success');

            if (content.trim().length === 0) {
                composerError.textContent = 'Write a message first.';
                return;
            }

            if (content.length > 2000) {
                composerError.textContent = 'Message is over the 2000 character limit.';
                return;
            }

            if (state.channel == null) {
                composerError.textContent = 'Pick a channel from the list first.';
                return;
            }

            // two-step confirmation so a stray click doesn't post to a server
            if (!sendBtn.classList.contains('armed')) {
                sendBtn.classList.add('armed');
                sendBtn.textContent = 'Confirm send?';
                armTimer = setTimeout(disarm, 3000);
                return;
            }

            disarm();
            sendBtn.disabled = true;

            try {
                await api('/api/channels/' + encodeURIComponent(state.channel) + '/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: content })
                });

                textarea.value = '';
                charCount.textContent = '0 / 2000';
                composerError.classList.add('composer-success');
                composerError.textContent = 'Sent \u2713';

                setTimeout(function () {
                    composerError.textContent = '';
                    composerError.classList.remove('composer-success');
                }, 2500);

                state.events = await fetchGuildActivity(guildId, state, null);
                renderGuildActivityList(guildId);
            } catch (err) {
                if (!err.unauthorized)
                    composerError.textContent = err.message;
            } finally {
                sendBtn.disabled = false;
            }
        });

        $('#guild-type-filter').addEventListener('change', function () {
            state.type = this.value;
            state.expanded = false;
            refreshGuildActivity(guildId);
        });

        var searchTimer = null;

        $('#guild-search').addEventListener('input', function () {
            var value = this.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () {
                state.q = value;
                state.expanded = false;
                refreshGuildActivity(guildId);
            }, 300);
        });

        renderGuildActivityList(guildId);

        pollTimer = setInterval(async function () {
            if (document.visibilityState !== 'visible' || state.expanded)
                return;

            try {
                state.events = await fetchGuildActivity(guildId, state, null);
                renderGuildActivityList(guildId);
            } catch (err) { /* transient */ }
        }, 5000);
    }

    async function refreshGuildActivity(guildId) {
        var state = guildPage[guildId];

        if (!state) return;

        try {
            state.events = await fetchGuildActivity(guildId, state, null);
            renderGuildActivityList(guildId);
        } catch (err) {
            if (!err.unauthorized)
                $('#guild-activity-list').innerHTML = errorCard(err.message);
        }
    }

    function renderGuildActivityList(guildId) {
        var state = guildPage[guildId];

        if (!state) return;

        var holder = $('#guild-activity-list');

        if (holder == null) return;

        var html = eventsTableHtml(state.events, false);

        if (state.events.length >= 50)
            html += '<div class="load-more-wrap"><button id="guild-load-more">Load older activity</button></div>';

        holder.innerHTML = html;

        var loadMore = $('#guild-load-more');

        if (loadMore != null) {
            loadMore.addEventListener('click', async function () {
                var oldest = state.events[state.events.length - 1];

                try {
                    var older = await fetchGuildActivity(guildId, state, oldest.t);
                    state.expanded = true;
                    state.events = state.events.concat(older);
                    renderGuildActivityList(guildId);
                } catch (err) { /* transient */ }
            });
        }
    }

    // ---------- global activity ----------

    async function renderActivity() {
        setActiveNav('activity');

        var content = $('#content');
        content.innerHTML = '<h1 class="page-title">Activity</h1>' +
            '<p class="page-sub">Live feed across all servers — commands, messages and dashboard actions</p>' +
            '<div class="filter-bar">' +
            '<select id="activity-guild-filter"><option value="">All servers</option></select>' +
            '<select id="activity-type-filter">' +
            '<option value="">All types</option>' +
            '<option value="command"' + (activityState.type === 'command' ? ' selected' : '') + '>Commands</option>' +
            '<option value="message"' + (activityState.type === 'message' ? ' selected' : '') + '>Messages</option>' +
            '<option value="dashboard"' + (activityState.type === 'dashboard' ? ' selected' : '') + '>Dashboard</option>' +
            '</select>' +
            '<input type="text" id="activity-search" placeholder="Search user, command or content\u2026" value="' + esc(activityState.q) + '">' +
            '<span class="live-badge"><span class="live-dot"></span>live</span>' +
            '</div>' +
            '<div id="activity-list"><div class="empty-state">Loading\u2026</div></div>';

        if (guildsCache == null) {
            try {
                guildsCache = (await api('/api/guilds')).guilds;
            } catch (err) {
                if (err.unauthorized) return;
            }
        }

        var guildSelect = $('#activity-guild-filter');

        (guildsCache || []).forEach(function (guild) {
            var option = document.createElement('option');
            option.value = guild.id;
            option.textContent = guild.name;
            option.selected = activityState.guild === guild.id;
            guildSelect.appendChild(option);
        });

        guildSelect.addEventListener('change', function () {
            activityState.guild = this.value;
            activityState.expanded = false;
            refreshActivity();
        });

        $('#activity-type-filter').addEventListener('change', function () {
            activityState.type = this.value;
            activityState.expanded = false;
            refreshActivity();
        });

        var searchTimer = null;

        $('#activity-search').addEventListener('input', function () {
            var value = this.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () {
                activityState.q = value;
                activityState.expanded = false;
                refreshActivity();
            }, 300);
        });

        await refreshActivity();

        pollTimer = setInterval(async function () {
            if (document.visibilityState !== 'visible' || activityState.expanded)
                return;

            try {
                await refreshActivity(false);
            } catch (err) { /* transient */ }
        }, 5000);
    }

    async function refreshActivity(showLoader) {
        var events;

        try {
            events = (await api(activityQuery(activityState, null, 50))).events;
        } catch (err) {
            if (!err.unauthorized)
                $('#activity-list').innerHTML = errorCard(err.message);
            return;
        }

        activityState.lastEvents = events;

        var html = eventsTableHtml(events, true);

        if (events.length >= 50)
            html += '<div class="load-more-wrap"><button id="activity-load-more">Load older activity</button></div>';

        var holder = $('#activity-list');

        if (holder == null) return;

        if (showLoader !== false) {
            holder.innerHTML = html;
        } else {
            // avoid wiping scroll position on background refreshes
            var scroll = holder.querySelector('.table-scroll');
            var keepScroll = scroll != null ? scroll.scrollTop : 0;
            holder.innerHTML = html;
            scroll = holder.querySelector('.table-scroll');
            if (scroll != null) scroll.scrollTop = keepScroll;
        }

        var loadMore = $('#activity-load-more');

        if (loadMore != null) {
            loadMore.addEventListener('click', async function () {
                var oldest = activityState.lastEvents[activityState.lastEvents.length - 1];

                try {
                    var older = (await api(activityQuery(activityState, oldest.t, 50))).events;
                    activityState.expanded = true;
                    activityState.lastEvents = activityState.lastEvents.concat(older);

                    var moreHtml = eventsTableHtml(activityState.lastEvents, true);
                    if (activityState.lastEvents.length >= 50 && older.length > 0)
                        moreHtml += '<div class="load-more-wrap"><button id="activity-load-more">Load older activity</button></div>';

                    $('#activity-list').innerHTML = moreHtml;
                    attachLoadMore();
                } catch (err) { /* transient */ }
            });
        }
    }

    function attachLoadMore() {
        var loadMore = $('#activity-load-more');

        if (loadMore == null) return;

        loadMore.addEventListener('click', async function () {
            var oldest = activityState.lastEvents[activityState.lastEvents.length - 1];

            try {
                var older = (await api(activityQuery(activityState, oldest.t, 50))).events;
                activityState.lastEvents = activityState.lastEvents.concat(older);

                var moreHtml = eventsTableHtml(activityState.lastEvents, true);
                if (older.length > 0)
                    moreHtml += '<div class="load-more-wrap"><button id="activity-load-more">Load older activity</button></div>';

                $('#activity-list').innerHTML = moreHtml;
                attachLoadMore();
            } catch (err) { /* transient */ }
        });
    }

    // ---------- commands reference ----------

    async function renderCommands() {
        setActiveNav('commands');

        var content = $('#content');
        content.innerHTML = '<h1 class="page-title">Commands</h1>' +
            '<p class="page-sub">Reference of loaded commands</p>' +
            '<div class="filter-bar"><input type="text" id="commands-search" placeholder="Search commands\u2026"></div>' +
            '<div id="commands-body"><div class="empty-state">Loading\u2026</div></div>';

        var data;

        try {
            data = await api('/api/commands');
        } catch (err) {
            if (err.unauthorized) return;
            $('#commands-body').innerHTML = errorCard(err.message);
            return;
        }

        var prefix = data.prefix || '';

        function renderList(filter) {
            var list = data.commands.filter(function (command) {
                if (!filter) return true;

                var haystack = (command.command + ' ' + command.aliases.join(' ') + ' ' +
                    (command.description || '') + ' ' + (command.usage || '')).toLowerCase();

                return haystack.includes(filter.toLowerCase());
            });

            var html = '<div class="table-wrap"><table><thead><tr>' +
                '<th>Command</th><th>Aliases</th><th>Usage</th><th>Description</th></tr></thead><tbody>';

            list.forEach(function (command) {
                html += '<tr>' +
                    '<td><code>' + esc(prefix + command.command) + '</code></td>' +
                    '<td class="cmd-aliases">' + (command.aliases.length > 0 ? command.aliases.map(function (a) { return esc(prefix + a); }).join(', ') : '—') + '</td>' +
                    '<td>' + (command.usage ? '<code>' + esc(command.usage) + '</code>' : '—') + '</td>' +
                    '<td class="t-detail">' + esc(command.description || '') + '</td>' +
                    '</tr>';
            });

            html += '</tbody></table></div>';

            if (list.length === 0)
                html = '<div class="empty-state">No commands match.</div>';

            $('#commands-body').innerHTML = html;
        }

        renderList('');

        var searchTimer = null;

        $('#commands-search').addEventListener('input', function () {
            var value = this.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () { renderList(value); }, 200);
        });
    }

    // ---------- boot ----------

    $('#login-form').addEventListener('submit', tryLogin);
    $('#logout-btn').addEventListener('click', logout);
    window.addEventListener('hashchange', route);

    (async function boot() {
        try {
            await api('/api/me');
            showApp();
        } catch (err) {
            if (!err.unauthorized)
                showLogin();
        }
    })();
})();
