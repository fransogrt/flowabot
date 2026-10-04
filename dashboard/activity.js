// Activity log + command usage stats for the dashboard.
// Keeps a ring buffer of the most recent events in memory and persists both
// the buffer and cumulative counters to ./data (activity_log, command_stats)
// through helper's LocalStorage, flushing at most once per minute.

const helper = require('../helper.js');

const MAX_EVENTS = 2000;
const MAX_PREVIEW = 200;
const FLUSH_EVERY = 60 * 1000;

let events = [];
let stats = {};
let dirty = false;
let flusher = null;

function load() {
    try {
        if (helper.getItem('activity_log'))
            events = JSON.parse(helper.getItem('activity_log')) || [];
    } catch (err) {
        events = [];
    }

    try {
        if (helper.getItem('command_stats'))
            stats = JSON.parse(helper.getItem('command_stats')) || {};
    } catch (err) {
        stats = {};
    }
}

function flush() {
    dirty = false;

    try {
        helper.setItem('activity_log', JSON.stringify(events));
        helper.setItem('command_stats', JSON.stringify(stats));
    } catch (err) {
        console.error('dashboard: failed to persist activity: ' + err);
    }
}

load();

// Buffer writes are batched so a busy server doesn't hammer the disk.
flusher = setInterval(() => {
    if (dirty)
        flush();
}, FLUSH_EVERY);
flusher.unref();

function push(event) {
    events.push(event);

    if (events.length > MAX_EVENTS)
        events.splice(0, events.length - MAX_EVENTS);

    dirty = true;
}

// Logs an event coming from Discord (guild messages only, real users only).
// type: 'command' | 'message'; extras: { command, content }
function logDiscordEvent(msg, type, extras = {}) {
    if (msg == null || msg.guild == null || msg.author == null || msg.author.bot)
        return;

    push({
        t: Date.now(),
        type: type,
        guild: msg.guild.id,
        guild_name: msg.guild.name,
        channel: msg.channel != null ? msg.channel.id : null,
        channel_name: msg.channel != null ? msg.channel.name : null,
        user: msg.author.id,
        user_name: msg.author.username,
        command: extras.command || null,
        content: (extras.content != null ? String(extras.content) : '').slice(0, MAX_PREVIEW)
    });

    if (type === 'command' && extras.command)
        bumpStats(extras.command, msg);
}

// Logs a message sent through the dashboard composer.
function logDashboardSend(channel, content) {
    push({
        t: Date.now(),
        type: 'dashboard',
        guild: channel.guild != null ? channel.guild.id : null,
        guild_name: channel.guild != null ? channel.guild.name : null,
        channel: channel.id,
        channel_name: channel.name,
        user: null,
        user_name: 'dashboard',
        command: null,
        content: String(content != null ? content : '').slice(0, MAX_PREVIEW)
    });

    flush();
}

function bumpStats(command, msg) {
    if (stats[command] == null)
        stats[command] = { total: 0, guilds: {}, users: {}, last_used: 0 };

    let entry = stats[command];
    entry.total++;
    entry.last_used = Date.now();

    if (entry.guilds[msg.guild.id] == null)
        entry.guilds[msg.guild.id] = { count: 0, name: msg.guild.name };

    entry.guilds[msg.guild.id].count++;
    entry.guilds[msg.guild.id].name = msg.guild.name;

    if (entry.users[msg.author.id] == null)
        entry.users[msg.author.id] = { count: 0, name: msg.author.username };

    entry.users[msg.author.id].count++;
    entry.users[msg.author.id].name = msg.author.username;

    dirty = true;
}

// Returns events newest-first, optionally filtered.
// opts: { guild, type, q, before (epoch ms), limit }
function getEvents(opts = {}) {
    let limit = opts.limit || 100;
    let q = opts.q ? opts.q.toLowerCase() : null;
    let out = [];

    for (let i = events.length - 1; i >= 0; i--) {
        let e = events[i];

        if (opts.before && e.t >= opts.before)
            continue;

        if (opts.guild && e.guild !== opts.guild)
            continue;

        if (opts.type && e.type !== opts.type)
            continue;

        if (q) {
            let haystack = ((e.user_name || '') + ' ' + (e.command || '') + ' ' +
                (e.content || '') + ' ' + (e.guild_name || '') + ' ' +
                (e.channel_name || '')).toLowerCase();

            if (!haystack.includes(q))
                continue;
        }

        out.push(e);

        if (out.length >= limit)
            break;
    }

    return out;
}

// Aggregated usage stats: top commands, top users, per-guild usage.
function getStats() {
    let commands = Object.keys(stats).map(name => ({
        command: name,
        total: stats[name].total,
        last_used: stats[name].last_used,
        guilds: stats[name].guilds,
        users: stats[name].users
    }));

    commands.sort((a, b) => b.total - a.total);

    let user_totals = {};
    let guild_totals = {};

    commands.forEach(c => {
        Object.keys(c.users).forEach(user_id => {
            if (user_totals[user_id] == null)
                user_totals[user_id] = { count: 0, name: c.users[user_id].name };

            user_totals[user_id].count += c.users[user_id].count;
            user_totals[user_id].name = c.users[user_id].name;
        });

        Object.keys(c.guilds).forEach(guild_id => {
            if (guild_totals[guild_id] == null)
                guild_totals[guild_id] = { count: 0, name: c.guilds[guild_id].name };

            guild_totals[guild_id].count += c.guilds[guild_id].count;
            guild_totals[guild_id].name = c.guilds[guild_id].name;
        });
    });

    let top_users = Object.keys(user_totals).map(id => ({ id: id, name: user_totals[id].name, count: user_totals[id].count }));
    top_users.sort((a, b) => b.count - a.count);

    let guild_usage = Object.keys(guild_totals).map(id => ({ id: id, name: guild_totals[id].name, count: guild_totals[id].count }));
    guild_usage.sort((a, b) => b.count - a.count);

    return {
        total_commands: commands.reduce((acc, c) => acc + c.total, 0),
        distinct_commands: commands.length,
        events_in_buffer: events.length,
        top_commands: commands.slice(0, 15).map(c => ({ command: c.command, total: c.total, last_used: c.last_used })),
        top_users: top_users.slice(0, 15),
        guild_usage: guild_usage
    };
}

module.exports = {
    logDiscordEvent: logDiscordEvent,
    logDashboardSend: logDashboardSend,
    getEvents: getEvents,
    getStats: getStats
};
