// Dashboard web server: password auth + JSON API + static frontend.
// Started from index.js once the Discord client is ready. Runs in the same
// process as the bot so it has live access to the client and its caches.
// No external dependencies: raw node:http only.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const helper = require('../helper.js');
const activity = require('./activity.js');

const { ChannelType, PermissionsBitField } = require('discord.js');

const SESSION_COOKIE = 'flowabot_session';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 128 * 1024;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW = 15 * 60 * 1000;
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2'
};

const public_dir = path.join(__dirname, 'public');

let client = null;
let commands = null;
let config = null;
let password = null;
let server = null;
let boot_warning_shown = false;

const sessions = new Map();       // token -> expiry (epoch ms)
const login_attempts = new Map(); // ip -> { count, window_start }

function log(...args) {
    helper.log('[dashboard]', ...args);
}

function randomPassword() {
    return crypto.randomBytes(12).toString('hex');
}

function timingSafeEqual(a, b) {
    let hash_a = crypto.createHash('sha256').update(String(a)).digest();
    let hash_b = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hash_a, hash_b);
}

function parseCookies(req) {
    let header = req.headers.cookie;
    let cookies = {};

    if (header == null)
        return cookies;

    header.split(';').forEach(part => {
        let index = part.indexOf('=');

        if (index === -1)
            return;

        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    });

    return cookies;
}

function currentSession(req) {
    let token = parseCookies(req)[SESSION_COOKIE];

    if (token == null || !sessions.has(token))
        return null;

    let expiry = sessions.get(token);

    if (Date.now() > expiry) {
        sessions.delete(token);
        return null;
    }

    return token;
}

function sendJson(res, status, obj, headers = {}) {
    let body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    }, headers));
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let chunks = [];

        req.on('data', chunk => {
            size += chunk.length;

            if (size > MAX_BODY) {
                reject('body too large');
                req.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {
            try {
                resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
                reject('invalid JSON body');
            }
        });

        req.on('error', reject);
    });
}

function loginBlocked(ip) {
    let entry = login_attempts.get(ip);

    if (entry == null)
        return false;

    if (Date.now() - entry.window_start > LOGIN_WINDOW) {
        login_attempts.delete(ip);
        return false;
    }

    return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
    let entry = login_attempts.get(ip);

    if (entry == null || Date.now() - entry.window_start > LOGIN_WINDOW) {
        entry = { count: 0, window_start: Date.now() };
        login_attempts.set(ip, entry);
    }

    entry.count++;
}

// --- serialization helpers ---------------------------------------------

function serializeGuild(guild) {
    let icon = null;

    try {
        icon = typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 128 }) : null;
    } catch (err) {
        icon = null;
    }

    return {
        id: guild.id,
        name: guild.name,
        icon: icon,
        member_count: guild.memberCount != null ? guild.memberCount : null,
        owner_id: guild.ownerId != null ? guild.ownerId : null
    };
}

function canSend(channel) {
    try {
        if (typeof channel.permissionsFor !== 'function' || client.user == null)
            return true;

        let perms = channel.permissionsFor(client.user.id);

        if (perms == null || typeof perms.has !== 'function')
            return true;

        return perms.has(PermissionsBitField.Flags.SendMessages);
    } catch (err) {
        return true;
    }
}

function guildChannels(guild) {
    let text_type = ChannelType != null && ChannelType.GuildText != null ? ChannelType.GuildText : 0;
    let announcement_type = ChannelType != null && ChannelType.GuildAnnouncement != null ? ChannelType.GuildAnnouncement : 5;
    let category_type = ChannelType != null && ChannelType.GuildCategory != null ? ChannelType.GuildCategory : 4;

    let all = Array.from(guild.channels.cache.values());

    let serialize = channel => ({
        id: channel.id,
        name: channel.name,
        topic: channel.topic != null ? String(channel.topic).slice(0, 200) : null,
        can_send: canSend(channel)
    });

    let categories = all
        .filter(c => c.type === category_type)
        .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
        .map(category => ({
            id: category.id,
            name: category.name,
            channels: all
                .filter(c => c.parentId === category.id && (c.type === text_type || c.type === announcement_type))
                .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
                .map(serialize)
        }));

    let uncategorized = all
        .filter(c => c.parentId == null && (c.type === text_type || c.type === announcement_type))
        .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))
        .map(serialize);

    if (uncategorized.length > 0)
        categories.push({ id: null, name: 'No category', channels: uncategorized });

    return categories.filter(category => category.channels.length > 0);
}

function trackedUsersCount() {
    try {
        let raw = helper.getItem('tracked_users');
        return raw ? Object.keys(JSON.parse(raw)).length : 0;
    } catch (err) {
        return 0;
    }
}

// --- API routes ---------------------------------------------------------

async function handleApi(req, res, pathname, params) {
    let method = req.method;

    // --- auth-free routes ---

    if (method === 'POST' && pathname === '/api/login') {
        let ip = req.socket.remoteAddress || 'unknown';

        if (loginBlocked(ip))
            return sendJson(res, 429, { error: 'Too many attempts, try again in a few minutes.' });

        let body = await readBody(req);

        if (body.password == null || !timingSafeEqual(body.password, password)) {
            recordFailedLogin(ip);
            return sendJson(res, 401, { error: 'Wrong password.' });
        }

        login_attempts.delete(ip);

        let token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL);

        return sendJson(res, 200, { ok: true }, {
            'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`
        });
    }

    if (currentSession(req) == null)
        return sendJson(res, 401, { error: 'Not logged in.' });

    // --- authenticated routes ---

    if (method === 'POST' && pathname === '/api/logout') {
        sessions.delete(parseCookies(req)[SESSION_COOKIE]);
        return sendJson(res, 200, { ok: true }, {
            'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
        });
    }

    if (method === 'GET' && pathname === '/api/me')
        return sendJson(res, 200, { ok: true, bot: client.user != null ? client.user.tag : null });

    if (method === 'GET' && pathname === '/api/status') {
        let memory = process.memoryUsage();
        let version = null;

        try {
            version = require('../package.json').version;
        } catch (err) {
            version = null;
        }

        return sendJson(res, 200, {
            ok: true,
            bot: {
                id: client.user != null ? client.user.id : null,
                tag: client.user != null ? client.user.tag : null,
                avatar: client.user != null && typeof client.user.displayAvatarURL === 'function'
                    ? client.user.displayAvatarURL({ extension: 'png', size: 128 })
                    : null
            },
            version: version,
            uptime_seconds: client.uptime != null ? Math.floor(client.uptime / 1000) : null,
            started_at: client.uptime != null ? Date.now() - client.uptime : null,
            ping: client.ws != null ? client.ws.ping : null,
            guilds: client.guilds != null ? client.guilds.cache.size : 0,
            commands_available: Array.isArray(commands) ? commands.length : 0,
            tracked_users: trackedUsersCount(),
            memory: {
                rss_mb: Math.round(memory.rss / 1048576),
                heap_used_mb: Math.round(memory.heapUsed / 1048576),
                heap_total_mb: Math.round(memory.heapTotal / 1048576)
            },
            node: process.version
        });
    }

    if (method === 'GET' && pathname === '/api/guilds') {
        let guilds = Array.from(client.guilds.cache.values())
            .map(serializeGuild)
            .sort((a, b) => (b.member_count || 0) - (a.member_count || 0));

        return sendJson(res, 200, { ok: true, guilds: guilds });
    }

    let guild_match = pathname.match(/^\/api\/guilds\/(\d+)$/);

    if (method === 'GET' && guild_match != null) {
        let guild = client.guilds.cache.get(guild_match[1]);

        if (guild == null)
            return sendJson(res, 404, { error: 'Guild not found.' });

        return sendJson(res, 200, Object.assign({ ok: true }, serializeGuild(guild), {
            channels: guildChannels(guild)
        }));
    }

    if (method === 'GET' && pathname === '/api/activity') {
        return sendJson(res, 200, {
            ok: true,
            events: activity.getEvents({
                guild: params.get('guild') || undefined,
                type: params.get('type') || undefined,
                q: params.get('q') || undefined,
                before: params.get('before') ? parseInt(params.get('before')) : undefined,
                limit: params.get('limit') ? Math.min(parseInt(params.get('limit')) || 100, 200) : 100
            })
        });
    }

    let guild_activity_match = pathname.match(/^\/api\/guilds\/(\d+)\/activity$/);

    if (method === 'GET' && guild_activity_match != null) {
        let guild = client.guilds.cache.get(guild_activity_match[1]);

        if (guild == null)
            return sendJson(res, 404, { error: 'Guild not found.' });

        return sendJson(res, 200, {
            ok: true,
            events: activity.getEvents({
                guild: guild_activity_match[1],
                type: params.get('type') || undefined,
                q: params.get('q') || undefined,
                before: params.get('before') ? parseInt(params.get('before')) : undefined,
                limit: params.get('limit') ? Math.min(parseInt(params.get('limit')) || 100, 200) : 100
            })
        });
    }

    if (method === 'GET' && pathname === '/api/stats')
        return sendJson(res, 200, Object.assign({ ok: true }, activity.getStats()));

    if (method === 'GET' && pathname === '/api/commands') {
        let list = (Array.isArray(commands) ? commands : []).map(command => {
            let names = Array.isArray(command.command) ? command.command : [command.command];

            return {
                command: names[0],
                aliases: names.slice(1),
                description: Array.isArray(command.description) ? command.description.join(' ') : (command.description || null),
                usage: command.usage || null,
                args_required: command.argsRequired != null ? command.argsRequired : 0
            };
        });

        list.sort((a, b) => String(a.command).localeCompare(String(b.command)));

        return sendJson(res, 200, { ok: true, prefix: config.prefix, commands: list });
    }

    let send_match = pathname.match(/^\/api\/channels\/(\d+)\/messages$/);

    if (method === 'POST' && send_match != null) {
        let body = await readBody(req);
        let content = body.content;

        if (typeof content !== 'string' || content.trim().length === 0)
            return sendJson(res, 400, { error: 'Message content is required.' });

        if (content.length > 2000)
            return sendJson(res, 400, { error: 'Message is longer than Discord\u2019s 2000 character limit.' });

        let channel = client.channels.cache.get(send_match[1]);

        if (channel == null) {
            try {
                channel = await client.channels.fetch(send_match[1]);
            } catch (err) {
                channel = null;
            }
        }

        if (channel == null)
            return sendJson(res, 404, { error: 'Channel not found.' });

        if (typeof channel.isTextBased === 'function' && !channel.isTextBased())
            return sendJson(res, 400, { error: 'That channel is not a text channel.' });

        if (typeof channel.send !== 'function')
            return sendJson(res, 400, { error: 'Cannot send messages to that channel.' });

        if (channel.guild != null && !canSend(channel))
            return sendJson(res, 403, { error: 'The bot is missing permission to send messages in that channel.' });

        try {
            let sent = await channel.send(content);
            activity.logDashboardSend(channel, content);

            return sendJson(res, 200, { ok: true, message_id: sent != null ? sent.id : null });
        } catch (err) {
            return sendJson(res, 502, { error: 'Discord rejected the message: ' + (err && err.message ? err.message : err) });
        }
    }

    return sendJson(res, 404, { error: 'Unknown API route.' });
}

// --- static files -------------------------------------------------------

function serveStatic(res, pathname) {
    let relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file_path = path.join(public_dir, relative);

    if (!file_path.startsWith(public_dir))
        return sendJson(res, 403, { error: 'Forbidden.' });

    fs.readFile(file_path, (err, data) => {
        if (err) {
            // Unknown paths fall back to index.html so the hash router works.
            if (pathname !== '/') {
                return serveStatic(res, '/');
            }

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('Not found.');
        }

        let ext = path.extname(file_path).toLowerCase();
        let mime = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': data.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(data);
    });
}

// --- server -------------------------------------------------------------

function handleRequest(req, res) {
    handle(req, res).catch(err => {
        if (err === 'body too large')
            return sendJson(res, 413, { error: 'Request body too large.' });

        if (err === 'invalid JSON body')
            return sendJson(res, 400, { error: 'Invalid JSON body.' });

        helper.error('[dashboard] request failed: ' + (err && err.stack ? err.stack : err));

        if (!res.headersSent)
            sendJson(res, 500, { error: 'Internal dashboard error.' });
    });
}

async function handle(req, res) {
    let parsed = new URL(req.url, 'http://localhost');
    let pathname = parsed.pathname;
    let params = parsed.searchParams;

    if (pathname.startsWith('/api/'))
        return handleApi(req, res, pathname, params);

    if (req.method === 'GET' || req.method === 'HEAD')
        return serveStatic(res, pathname);

    return sendJson(res, 405, { error: 'Method not allowed.' });
}

function init(opts) {
    client = opts.client;
    commands = opts.commands;
    config = opts.config;

    if (server != null)
        return;

    let dashboard_config = config.dashboard || {};
    let port = parseInt(dashboard_config.port) || 8080;
    password = typeof dashboard_config.password === 'string' && dashboard_config.password.length > 0
        ? dashboard_config.password
        : null;

    server = http.createServer(handleRequest);
    server.on('error', err => {
        helper.error('[dashboard] server error: ' + err);
    });

    server.listen(port, '0.0.0.0', () => {
        log(`listening on http://0.0.0.0:${port}`);

        if (password == null) {
            password = randomPassword();

            if (!boot_warning_shown) {
                boot_warning_shown = true;
                log('no dashboard password set in config.json, generated a random one for this boot:');
                log(`password: ${password}`);
                log('(set config.dashboard.password to make it permanent — check me with: docker logs flowabot)');
            }
        }
    });

    // Sweeps expired sessions hourly; doesn't keep the process alive.
    let sweeper = setInterval(() => {
        let now = Date.now();
        Array.from(sessions.keys()).forEach(token => {
            if (now > sessions.get(token))
                sessions.delete(token);
        });
    }, 3600 * 1000);
    sweeper.unref();
}

module.exports = {
    init: init
};
