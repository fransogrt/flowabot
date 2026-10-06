// Standalone lb command test harness: exercises the real ;lb command module
// end-to-end against msg/channel/guild doubles that record send/edit/delete/react,
// a simulated reaction collector, and a runtime patch of osu.get_user_stats
// on the same osu module instance the command uses (no real network, no
// Discord connection). Not part of the bot.
// Run from the repo root: node test/lb-test.js

const Module = require('module');

// ---------------------------------------------------------------------------
// Module loading. On machines with broken native binaries (canvas,
// lzma-native) the plain require of commands/lb.js (-> osu.js -> renderer
// chain) throws. chartjs-node-canvas is stubbed too because osu.js constructs
// it at load time and its constructor re-requires canvas via freshRequire,
// which would bypass the require.cache stub for canvas. The stubs only cover
// the score-rendering paths the leaderboard never touches; on a healthy
// machine the first require succeeds and no stub is installed at all.
// ---------------------------------------------------------------------------

function stubModule(request, exports) {
    const resolved = require.resolve(request);
    const stub = new Module(resolved, null);
    stub.exports = exports;
    stub.filename = resolved;
    stub.loaded = true;
    require.cache[resolved] = stub;
}

const NATIVE_STUBS = [
    ['canvas', {
        createCanvas: () => { throw new Error('canvas stub: rendering is not part of the lb tests'); },
        loadImage: async () => { throw new Error('canvas stub: rendering is not part of the lb tests'); },
        registerFont: () => {}
    }],
    ['chartjs-node-canvas', { ChartJSNodeCanvas: class ChartJSNodeCanvas {} }],
    ['lzma-native', {
        LZMA: function LZMA() {},
        Decompress: class Decompress {},
        compress: () => { throw new Error('lzma-native stub'); },
        decompress: () => { throw new Error('lzma-native stub'); }
    }]
];

const RENDERER_STUBS = [
    ['../renderer/ur.js', { get_ur: async () => null }],
    ['../renderer/render_frame.js', { get_frame: function get_frame() {}, get_frames: async () => [] }]
];

function dropRepoModuleCache() {
    // after a failed require, drop the partially-initialised copies of the
    // repo's own modules so the retry re-executes them cleanly with the
    // stubs in place
    for(const request of ['../commands/lb.js', '../osu.js', '../helper.js', ...RENDERER_STUBS.map(([r]) => r)]) {
        try { delete require.cache[require.resolve(request)]; } catch(err) { /* not cached */ }
    }
}

let lb;
try {
    lb = require('../commands/lb.js');
} catch(firstError) {
    const layers = [NATIVE_STUBS, [...NATIVE_STUBS, ...RENDERER_STUBS]];
    for(const stubs of layers) {
        for(const [request, exports] of stubs) {
            try { stubModule(request, exports); } catch(err) { /* candidate not installed */ }
        }
        dropRepoModuleCache();
        try { lb = require('../commands/lb.js'); break; } catch(err) { /* try the next layer */ }
    }
    if(!lb) {
        console.error('lb-test: could not load commands/lb.js, even with the native-module stubs:');
        console.error(firstError.stack || String(firstError));
        process.exit(1);
    }
}

const osu = require('../osu.js');       // same module instance lb.js queries
const helper = require('../helper.js'); // same instance lb.js logs through

// keep the output concise; captured entries are only printed for failures
const helperMessages = [];
helper.log = (...parts) => helperMessages.push(parts.map(String).join(' '));
helper.error = (...parts) => helperMessages.push('error: ' + parts.map(p => (p && p.stack) || String(p)).join(' '));

// background navigation failures would surface here, not in the command promise
const unhandledRejections = [];
process.on('unhandledRejection', err => unhandledRejections.push(String((err && err.stack) || err)));

// ---------------------------------------------------------------------------
// Runtime patch of the stats query (never the real osu!api).
// ---------------------------------------------------------------------------

const statsCalls = [];

// behavior: ign => ({ stats } | { stats: null } (not found) | { err } (network))
function installStatsFake(behavior) {
    statsCalls.length = 0;
    osu.get_user_stats = (options, cb) => {
        statsCalls.push(options.u);
        setImmediate(() => {
            try {
                const result = behavior(options.u);
                if(result === null || result === undefined)
                    cb(null, null);
                else if(result.err)
                    cb(result.err, null);
                else
                    cb(null, result.stats);
            } catch(err) {
                cb('lb-test stats fake crashed: ' + err.message, null);
            }
        });
    };
}

function makeStats(id, username, pp, global_rank) {
    return { id, username, pp, global_rank };
}

// ---------------------------------------------------------------------------
// Doubles.
// ---------------------------------------------------------------------------

function makeCollector(sentMsg, options) {
    const listeners = { collect: [], end: [] };
    return {
        options,
        ended: false,
        stopCalls: 0,
        stopReason: null,
        on(event, fn) {
            listeners[event].push(fn);
            return this;
        },
        // mirrors discord.js: stopping the collector fires 'end'
        stop(reason) {
            this.stopCalls++;
            this.stopReason = reason;
            this.end();
        },
        end() {
            if(this.ended) return;
            this.ended = true;
            for(const fn of listeners.end) fn();
        },
        // a user pressing a reaction: runs through the command's own filter,
        // like the real collector does; returns false when filtered/expired
        press(emojiName, user, opts) {
            if(this.ended) return false;
            const removeFails = !!(opts && opts.removeFails);
            const reaction = {
                emoji: { name: emojiName },
                users: {
                    remove: async userId => {
                        if(removeFails)
                            throw new Error('Missing Permissions (simulated reaction removal failure)');
                    }
                }
            };
            if(options.filter && !options.filter(reaction, user))
                return false;
            for(const fn of listeners.collect) fn(reaction, user);
            return true;
        }
    };
}

function makeSentMsg(channel, content) {
    const sentMsg = {
        channel,
        initialContent: content, // the payload the message was sent with
        editAttempts: 0,   // every edit call, successful or not
        edits: [],         // successful edit payloads, in order
        reacts: [],        // emoji names passed to react()
        deleteCalls: 0,
        deleted: false,
        collectors: [],
        editMode: 'ok',    // 'ok' | 'reject'
        async edit(content) {
            this.editAttempts++;
            if(this.editMode === 'reject')
                throw new Error('Unknown Message (simulated edit failure)');
            this.edits.push(content);
            return this;
        },
        async react(emoji) {
            this.reacts.push(emoji);
            return this;
        },
        async delete() {
            this.deleteCalls++;
            // a real delete takes a round trip: only marking the message
            // deleted after an awaited tick lets the harness detect a reject
            // that does not wait for the delete to finish (Req 8.4)
            await new Promise(resolve => setImmediate(resolve));
            this.deleted = true;
            return this;
        },
        createReactionCollector(options) {
            const collector = makeCollector(this, options);
            this.collectors.push(collector);
            return collector;
        }
    };
    return sentMsg;
}

function makeChannel(name) {
    const channel = {
        name,
        sends: [],
        sentMsgs: [],
        async send(content) {
            this.sends.push(content);
            const sentMsg = makeSentMsg(this, content);
            this.sentMsgs.push(sentMsg);
            return sentMsg;
        }
    };
    return channel;
}

function makeGuild(name, memberIds) {
    const present = new Set(memberIds);
    const guild = {
        name,
        memberFetchCalls: 0,
        members: {
            fetch: async () => {
                guild.memberFetchCalls++;
                return { has: id => present.has(id) };
            }
        }
    };
    return guild;
}

function makeMsg(guild, channel) {
    return {
        guild: guild ?? null, // null guild = direct message
        channel,
        author: { id: 'caller-1', bot: false },
        content: ';lb'
    };
}

const PRESSER = { id: 'user-presser', bot: false };

// ---------------------------------------------------------------------------
// Small assertion machinery + runner.
// ---------------------------------------------------------------------------

let currentScenario = null;
const scenarioResults = [];
let totalChecks = 0;
let failedChecks = 0;

function check(name, condition, detail) {
    totalChecks++;
    const ok = !!condition;
    if(!ok) failedChecks++;
    currentScenario.checks.push({ name, ok, detail: ok ? undefined : String(detail) });
}

async function settle() {
    // let the fire-and-forget navigation handlers finish their awaited work
    for(let i = 0; i < 5; i++)
        await new Promise(resolve => setImmediate(resolve));
}

function runCommand(msg, user_ign) {
    return lb.call({ msg, user_ign });
}

const scenarios = [];
function scenario(name, fn) {
    scenarios.push({ name, fn });
}

// embed helpers (page payloads are { embeds: [EmbedBuilder] }; toJSON exposes
// color, title, description and footer.text)
function embedJson(editPayload) {
    return editPayload.embeds[0].toJSON();
}
function linesOf(editPayload) {
    return embedJson(editPayload).description.split('\n');
}
function lastLinesOf(sentMsg) {
    return linesOf(sentMsg.edits[sentMsg.edits.length - 1]);
}
function footerTextOf(editPayload) {
    const footer = embedJson(editPayload).footer;
    return footer ? footer.text : null;
}
// Rev 2 render: every IGN is a markdown link to the player's public osu!
// profile, [ign](https://osu.ppy.sh/u/{id}). Extracting from that exact shape
// keeps the assertions able to fail if the link (or its id) disappears.
function linkOf(line) {
    const match = line.match(/\[(.+?)\]\((https:\/\/osu\.ppy\.sh\/u\/[^)\s]+)\)/);
    return match ? { ign: match[1], url: match[2] } : null;
}
function ignOf(line) {
    const link = linkOf(line);
    return link ? link.ign : null;
}
// what a message currently displays: its last successful edit, or the payload
// it was sent with when never edited; null once deleted
function displayedContent(sentMsg) {
    if(sentMsg.deleted)
        return null;
    return sentMsg.edits.length ? sentMsg.edits[sentMsg.edits.length - 1] : sentMsg.initialContent;
}
function contentRepr(content) {
    if(content === null) return '(deleted)';
    if(typeof content === 'string') return JSON.stringify(content);
    return '[embed]';
}
// Req 8.1-8.4: no outcome may leave the building indicator on screen
function checkNoBuildingIndicator(channel, outcome) {
    const displayed = channel.sentMsgs.map(displayedContent);
    check("no message still displays 'Building leaderboard… 🔄' after " + outcome,
        displayed.every(content => content !== 'Building leaderboard… 🔄'),
        displayed.map(contentRepr).join(' | '));
}

// build a 12-player board (the canonical multi-page fixture)
function twelvePlayerFixture() {
    const rows = [
        ['toppp', 1234.6, 1],    // rounds to 1,235 (thousands separator)
        ['second', 900, 2],
        ['third', 800, 3],
        ['p4', 700, 4],
        ['p5', 650, 5],
        ['unranked', 600, null], // shows '—'
        ['p7', 550, 7],
        ['p8', 500, 8],
        ['p9', 450, 9],
        ['p10', 400, 10],
        ['p11', 350, 11],
        ['p12', 300, 12]
    ];
    const stats = {};
    const user_ign = {};
    rows.forEach(([name, pp, rank], i) => {
        stats[name] = makeStats('osu-' + (i + 1), name, pp, rank);
        user_ign['u-' + (i + 1)] = name;
    });
    return { rows, stats, user_ign };
}

async function startBoard(user_ign, memberIds, guildName) {
    const guild = makeGuild(guildName || 'Test Guild', memberIds || Object.keys(user_ign));
    const channel = makeChannel('general');
    const msg = makeMsg(guild, channel);
    const result = await runCommand(msg, user_ign);
    await settle();
    return { guild, channel, msg, result, sentMsg: channel.sentMsgs[0] };
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

// 1. Deterministic order (Req 3.1-3.3)
scenario('order: pp desc, global rank tiebreak, alphabetical tiebreak, unranked last; deterministic (Req 3.1-3.3)', async () => {
    const stats = {
        zeta: makeStats('osu-zeta', 'zeta', 700, 5),
        alpha: makeStats('osu-alpha', 'alpha', 500, 50),
        beta: makeStats('osu-beta', 'beta', 500, 50),   // double tie with alpha
        yy: makeStats('osu-yy', 'yy', 500, 90),
        mm: makeStats('osu-mm', 'mm', 500, null),       // unranked at 500pp
        aa: makeStats('osu-aa', 'aa', 300, 10),
        bb: makeStats('osu-bb', 'bb', 300, 10),         // double tie with aa
        low: makeStats('osu-low', 'low', 100, 1)
    };
    const user_ign = Object.fromEntries(Object.keys(stats).map(name => ['u-' + name, name]));
    installStatsFake(ign => ({ stats: stats[ign] }));

    const board = await startBoard(user_ign, null, 'Order Guild');
    check('call resolves null (the command owns its single message)', board.result === null, String(board.result));
    check('exactly one message was sent', board.channel.sends.length === 1 && board.sentMsg, 'sends: ' + board.channel.sends.length);
    check('placeholder edited once with an embed', board.sentMsg.edits.length === 1 && !!board.sentMsg.edits[0].embeds, 'edits: ' + board.sentMsg.edits.length);

    const lines = linesOf(board.sentMsg.edits[0]);
    const igns = lines.map(ignOf);
    const expected = ['zeta', 'alpha', 'beta', 'yy', 'mm', 'aa', 'bb', 'low'];
    check('full order is deterministic: pp desc -> rank asc -> IGN asc -> unranked after ranked at equal pp',
        JSON.stringify(igns) === JSON.stringify(expected), igns.join(' > '));
    check('equal pp ranked by better (lower) global rank first (alpha/#50 before yy/#90)',
        igns.indexOf('alpha') < igns.indexOf('yy'), igns.join(' > '));
    check('equal pp + equal rank ordered alphabetically (alpha before beta, aa before bb)',
        igns.indexOf('alpha') < igns.indexOf('beta') && igns.indexOf('aa') < igns.indexOf('bb'), igns.join(' > '));
    check('unranked entry (mm, rank null) sorts after ranked entries of the same pp (yy)',
        igns.indexOf('yy') < igns.indexOf('mm'), igns.join(' > '));

    // determinism: a second run over the same dataset renders byte-identical output
    const board2 = await startBoard(user_ign, null, 'Order Guild');
    const first = JSON.stringify(embedJson(board.sentMsg.edits[0]));
    const second = JSON.stringify(embedJson(board2.sentMsg.edits[0]));
    check('second run renders a byte-identical embed (determinism)', first === second);
});

// 2. Population (Req 2.1-2.3)
scenario('population: only present linked members; unresolvable IGN omitted without aborting; duplicate osu! ids deduped; blank IGN discarded (Req 2.1-2.3)', async () => {
    const stats = {
        InGuild: makeStats('osu-1', 'InGuild', 400, 20),
        SharedLink: makeStats('osu-dup', 'SharedLink', 350, 30),
        Renamed: null // osu! user no longer resolvable
    };
    const user_ign = {
        'u-present': 'InGuild',
        'u-gone': 'LeftGuild',   // linked but no longer a member
        'u-renamed': 'Renamed',
        'u-dup-a': 'SharedLink',
        'u-dup-b': 'SharedLink', // second Discord account, same osu! account
        'u-blank': '   '         // blank link
    };
    installStatsFake(ign => {
        if(!(ign in stats))
            return { err: 'unexpected osu! query for ' + ign };
        return { stats: stats[ign] };
    });

    const board = await startBoard(user_ign, ['u-present', 'u-renamed', 'u-dup-a', 'u-dup-b', 'u-blank'], 'Pop Guild');
    const igns = lastLinesOf(board.sentMsg).map(ignOf);
    check('call resolves null', board.result === null, String(board.result));
    check('absent member is excluded from the leaderboard', !igns.includes('LeftGuild'), igns.join(', '));
    check('absent member is never queried (not even looked up)', !statsCalls.includes('LeftGuild'), statsCalls.join(', '));
    check('blank IGN discarded without a query', !statsCalls.includes('   ') && !igns.includes('   '), statsCalls.join(', '));
    check('unresolvable IGN omitted without aborting the build', !igns.includes('Renamed'), igns.join(', '));
    check('the rest of the leaderboard is still built (2 entries: InGuild + SharedLink)', igns.length === 2 && igns.includes('InGuild') && igns.includes('SharedLink'), igns.join(', '));
    check('duplicate osu! id keeps only the first link', igns.filter(i => i === 'SharedLink').length === 1, igns.join(', '));
    check('exactly the resolvable present players queried (InGuild once, Renamed once, SharedLink twice)',
        statsCalls.length === 4 && statsCalls.filter(c => c === 'SharedLink').length === 2 && statsCalls.includes('InGuild') && statsCalls.includes('Renamed'),
        statsCalls.join(', '));
    check('guild members fetched exactly once', board.guild.memberFetchCalls === 1, String(board.guild.memberFetchCalls));
});

// 3. Render (Req 4.1, 4.3-4.5)
scenario('render: medals only on top 3, continuous numbering across pages, linked IGNs with bold pp, dash for unranked, no Discord mentions (Req 4.1, 4.3-4.5)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Render Guild');
    const lines = linesOf(board.sentMsg.edits[0]);
    check('line 1 wears the gold medal with rounded pp, thousands separator, profile link and bold pp',
        lines[0] === '🥇 [toppp](https://osu.ppy.sh/u/osu-1) • **1,235pp** • #1', JSON.stringify(lines[0]));
    check('line 2 wears the silver medal', lines[1] === '🥈 [second](https://osu.ppy.sh/u/osu-2) • **900pp** • #2', JSON.stringify(lines[1]));
    check('line 3 wears the bronze medal', lines[2] === '🥉 [third](https://osu.ppy.sh/u/osu-3) • **800pp** • #3', JSON.stringify(lines[2]));
    check('line 4 is numbered, not medalled', lines[3] === '4. [p4](https://osu.ppy.sh/u/osu-4) • **700pp** • #4', JSON.stringify(lines[3]));
    check('lines 4-10 all use continuous numbers, no medal anywhere below the podium',
        lines.slice(3).every((line, i) => line.startsWith(i + 4 + '. ') && !['🥇', '🥈', '🥉'].some(m => line.includes(m))),
        lines.join(' | '));
    check('unranked player shows an em-dash instead of a rank', lines[5] === '6. [unranked](https://osu.ppy.sh/u/osu-6) • **600pp** • —', JSON.stringify(lines[5]));
    check('footer on the multi-page board', footerTextOf(board.sentMsg.edits[0]) === '12 players · Page 1/2', String(footerTextOf(board.sentMsg.edits[0])));

    // navigate to page 2: numbering continues at 11
    const collector = board.sentMsg.collectors[0];
    check('collector attached for navigation', !!collector, String(collector));
    check('arrow press accepted', collector.press('➡️', PRESSER) === true);
    await settle();
    const page2 = lastLinesOf(board.sentMsg);
    check('page 2 numbering continues from page 1 (starts at 11)',
        page2.length === 2 && page2[0] === '11. [p11](https://osu.ppy.sh/u/osu-11) • **350pp** • #11' && page2[1] === '12. [p12](https://osu.ppy.sh/u/osu-12) • **300pp** • #12',
        page2.join(' | '));
    check('page 2 footer shows totals and page indicator', footerTextOf(board.sentMsg.edits[board.sentMsg.edits.length - 1]) === '12 players · Page 2/2');

    // Req 4.5: the full serialized embed must not contain any Discord mention
    const serialized = board.sentMsg.edits.map(payload => JSON.stringify(embedJson(payload))).join('\n');
    check('no mention (<@) anywhere in the serialized embeds', !serialized.includes('<@'), serialized.slice(0, 120));
});

// 4. Presentation Rev 2 (Req 4.2, 4.6, 7.1-7.4)
scenario('presentation: profile links with the correct osu! id, bold pp, accent color, server+mode title, footer with total on a single page, page indicator only when multi-page (Req 4.2, 4.6, 7.1-7.4)', async () => {
    // numeric osu! ids, as the real get_user_stats returns them
    const rows = [
        { id: 8712934, name: 'WavyTone', pp: 1000.4, rank: 42 },   // rounds to 1,000
        { id: 12345, name: 'midplayer', pp: 500, rank: null },     // unranked: shows '—'
        { id: 98765432, name: 'bottom', pp: 99.5, rank: 1234567 }, // rounds to 100
        { id: 555, name: 'fourth', pp: 50, rank: 999999 }          // position 4: numbered, not medalled
    ];
    const stats = {};
    const user_ign = {};
    rows.forEach((row, i) => {
        stats[row.name] = makeStats(row.id, row.name, row.pp, row.rank);
        user_ign['u-' + (i + 1)] = row.name;
    });
    installStatsFake(ign => ({ stats: stats[ign] }));

    const board = await startBoard(user_ign, null, 'Presentation Guild');
    const json = embedJson(board.sentMsg.edits[0]);
    const lines = json.description.split('\n');

    // Req 7.1: an accent of its own, not Discord's default blurple
    check('embed carries the osu! accent color (0xBB5577 = decimal 12277111)', json.color === 0xBB5577 && json.color === 12277111, String(json.color));
    // Req 7.2: server and game mode in the title
    check('title names the server and the game mode', json.title === 'Presentation Guild — osu! standard leaderboard', JSON.stringify(json.title));
    // Req 7.3: the total also on a single-page board
    check('footer present with the total on a single-page board', footerTextOf(board.sentMsg.edits[0]) === '4 players', JSON.stringify(footerTextOf(board.sentMsg.edits[0])));
    // Req 7.4: the page indicator only when there is more than one page
    check('no page indicator next to the total on a single-page board', footerTextOf(board.sentMsg.edits[0]) !== null && !footerTextOf(board.sentMsg.edits[0]).includes('Page'), JSON.stringify(footerTextOf(board.sentMsg.edits[0])));

    // Req 4.1 + 4.2 + 4.6: exact Rev 2 lines (link text = IGN, URL = its osu! id, bold pp);
    // the top 3 wear medals, position 4 is numbered
    const expected = [
        '🥇 [WavyTone](https://osu.ppy.sh/u/8712934) • **1,000pp** • #42',
        '🥈 [midplayer](https://osu.ppy.sh/u/12345) • **500pp** • —',
        '🥉 [bottom](https://osu.ppy.sh/u/98765432) • **100pp** • #1234567',
        '4. [fourth](https://osu.ppy.sh/u/555) • **50pp** • #999999'
    ];
    check('every entry line is exactly: prefix, IGN linked to its osu! id, bold pp with thousands separator, global rank',
        JSON.stringify(lines) === JSON.stringify(expected), JSON.stringify(lines));

    // Req 4.2 per entry: link text and profile id must match the same player
    const links = lines.map(linkOf);
    check('every IGN is rendered as a markdown profile link', links.every(Boolean), JSON.stringify(links));
    check('each IGN links to the profile of its own osu! id',
        rows.every((row, i) => links[i] && links[i].ign === row.name && links[i].url === 'https://osu.ppy.sh/u/' + row.id),
        JSON.stringify(links));
    // Req 4.6: the sorting metric stands out of the line text
    check('pp is bolded in every entry (**Npp**)', lines.every(line => /\*\*\d[\d,]*pp\*\*/.test(line)), lines.join(' | '));
    // Req 4.5 regression: identification by IGN, never a Discord mention
    check('no Discord mention (<@) anywhere in the embed', !JSON.stringify(json).includes('<@'), JSON.stringify(json).slice(0, 120));
});

// 5. Pagination (Req 5.1-5.5)
scenario('pagination: 10 players -> single static page, no arrows, no collector, footer with total and no page indicator (Req 5.4, 7.3, 7.4)', async () => {
    const user_ign = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['u-' + (i + 1), 'p' + (i + 1)]));
    const stats = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['p' + (i + 1), makeStats('osu-' + (i + 1), 'p' + (i + 1), 500 - i, null)]));
    installStatsFake(ign => ({ stats: stats[ign] }));

    const board = await startBoard(user_ign, null, 'Small Guild');
    check('call resolves null', board.result === null, String(board.result));
    check('no reactions added', board.sentMsg.reacts.length === 0, JSON.stringify(board.sentMsg.reacts));
    check('no reaction collector created', board.sentMsg.collectors.length === 0, String(board.sentMsg.collectors.length));
    check('footer with the total also on a single-page board (Req 7.3)', footerTextOf(board.sentMsg.edits[0]) === '10 players', JSON.stringify(footerTextOf(board.sentMsg.edits[0])));
    check('no page indicator on a single-page board (Req 7.4)', footerTextOf(board.sentMsg.edits[0]) !== null && !footerTextOf(board.sentMsg.edits[0]).includes('Page'), JSON.stringify(footerTextOf(board.sentMsg.edits[0])));
    check('all 10 entries rendered on the single page', lastLinesOf(board.sentMsg).length === 10, String(lastLinesOf(board.sentMsg).length));
});

scenario('pagination: 12 players -> arrows in order with 120 s TTL and footer (Req 5.1)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Arrow Guild');
    check('both arrows added, in order', JSON.stringify(board.sentMsg.reacts) === JSON.stringify(['⬅️', '➡️']), JSON.stringify(board.sentMsg.reacts));
    const collector = board.sentMsg.collectors[0];
    check('one reaction collector created', board.sentMsg.collectors.length === 1 && !!collector);
    check('collector lifetime is 120000 ms', collector.options.time === 120000, String(collector.options.time));
    check('footer present on page 1', embedJson(board.sentMsg.edits[0]).footer.text === '12 players · Page 1/2', String(embedJson(board.sentMsg.edits[0]).footer.text));
});

scenario('pagination: arrows update the same message in place, both directions (Req 5.2)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Nav Guild');
    const collector = board.sentMsg.collectors[0];
    const sendsAfterStart = board.channel.sends.length;

    check('press ➡️ accepted', collector.press('➡️', PRESSER) === true);
    await settle();
    check('still exactly one message in the channel', board.channel.sends.length === sendsAfterStart && board.channel.sentMsgs.length === 1, 'sends: ' + board.channel.sends.length);
    check('page 2 rendered by editing the same message', board.sentMsg.edits.length === 2 && lastLinesOf(board.sentMsg)[0] === '11. [p11](https://osu.ppy.sh/u/osu-11) • **350pp** • #11', 'edits: ' + board.sentMsg.edits.length);
    check('footer now reads Page 2/2', embedJson(board.sentMsg.edits[1]).footer.text === '12 players · Page 2/2');

    check('press ⬅️ accepted', collector.press('⬅️', PRESSER) === true);
    await settle();
    check('page 1 rendered again on the same message', board.sentMsg.edits.length === 3 && lastLinesOf(board.sentMsg)[0].includes('toppp'), 'edits: ' + board.sentMsg.edits.length);
    check('footer back to Page 1/2', embedJson(board.sentMsg.edits[2]).footer.text === '12 players · Page 1/2');
});

scenario('pagination: clamped at both ends, no wrap-around (Req 5.3)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Clamp Guild');
    const collector = board.sentMsg.collectors[0];

    check('➡️ to page 2', collector.press('➡️', PRESSER) === true);
    await settle();
    check('➡️ at the last page is a no-op', collector.press('➡️', PRESSER) === true);
    await settle();
    check('no new edit after ➡️ at the last page', board.sentMsg.edits.length === 2 && embedJson(board.sentMsg.edits[1]).footer.text === '12 players · Page 2/2', 'edits: ' + board.sentMsg.edits.length);

    check('⬅️ back to page 1', collector.press('⬅️', PRESSER) === true);
    await settle();
    check('⬅️ at the first page is a no-op', collector.press('⬅️', PRESSER) === true);
    await settle();
    check('no new edit after ⬅️ at the first page; message stays on page 1',
        board.sentMsg.edits.length === 3 && embedJson(board.sentMsg.edits[2]).footer.text === '12 players · Page 1/2',
        'edits: ' + board.sentMsg.edits.length);
});

scenario('pagination: filter rejects non-arrow emoji and bot pressers (Req 5.1)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Filter Guild');
    const collector = board.sentMsg.collectors[0];

    check('🎉 press rejected by the collector filter', collector.press('🎉', PRESSER) === false);
    check('bot presser rejected by the collector filter', collector.press('➡️', { id: 'bot-1', bot: true }) === false);
    await settle();
    check('filtered presses produced no edits', board.sentMsg.edits.length === 1, 'edits: ' + board.sentMsg.edits.length);
    check('valid press still works after filtered ones', collector.press('➡️', PRESSER) === true);
    await settle();
    check('navigation reached page 2', lastLinesOf(board.sentMsg)[0] === '11. [p11](https://osu.ppy.sh/u/osu-11) • **350pp** • #11', lastLinesOf(board.sentMsg).join(' | '));
});

scenario('pagination: expiry ends navigation and keeps the last page (Req 5.5)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Expiry Guild');
    const collector = board.sentMsg.collectors[0];

    check('➡️ to page 2', collector.press('➡️', PRESSER) === true);
    await settle();

    collector.end(); // simulated TTL expiry
    check('press after expiry is ignored', collector.press('➡️', PRESSER) === false);
    await settle();
    check('no new edits after expiry', board.sentMsg.edits.length === 2, 'edits: ' + board.sentMsg.edits.length);
    check('message keeps its last page after expiry', embedJson(board.sentMsg.edits[1]).footer.text === '12 players · Page 2/2');
    const expiryLog = helperMessages.find(m => m.includes('Leaderboard navigation expired'));
    check('expiry is logged through helper.log', !!expiryLog);
});

scenario('pagination: reaction removal failure degrades without stopping navigation (Req 5.2)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Degrade Guild');
    const collector = board.sentMsg.collectors[0];

    check('press with failing reaction removal still navigates', collector.press('➡️', PRESSER, { removeFails: true }) === true);
    await settle();
    check('page 2 reached despite the removal failure', lastLinesOf(board.sentMsg)[0] === '11. [p11](https://osu.ppy.sh/u/osu-11) • **350pp** • #11', lastLinesOf(board.sentMsg).join(' | '));
    check('the failure was logged, not swallowed silently', helperMessages.some(m => m.includes('Could not remove the navigation reaction')));
    check('collector was not stopped by the removal failure', collector.stopCalls === 0 && !collector.ended);

    check('next press with working removal still navigates back', collector.press('⬅️', PRESSER) === true);
    await settle();
    check('navigation continues after the degraded press', board.sentMsg.edits.length === 3 && embedJson(board.sentMsg.edits[2]).footer.text === '12 players · Page 1/2', 'edits: ' + board.sentMsg.edits.length);
});

scenario('pagination: edit failure stops the collector without crashing (Req 5.5)', async () => {
    const fixture = twelvePlayerFixture();
    installStatsFake(ign => ({ stats: fixture.stats[ign] }));

    const board = await startBoard(fixture.user_ign, null, 'Broken Edit Guild');
    const collector = board.sentMsg.collectors[0];

    board.sentMsg.editMode = 'reject';
    check('press attempted on a broken message', collector.press('➡️', PRESSER) === true);
    await settle();
    check('the failed edit was attempted', board.sentMsg.editAttempts === 2, 'attempts: ' + board.sentMsg.editAttempts);
    check('the message keeps the last successful embed (page 1)', board.sentMsg.edits.length === 1 && embedJson(board.sentMsg.edits[0]).footer.text === '12 players · Page 1/2', 'edits: ' + board.sentMsg.edits.length);
    check('collector.stop() was called', collector.stopCalls === 1 && collector.ended, 'stops: ' + collector.stopCalls);
    check('the edit failure was logged', helperMessages.some(m => m.includes('Could not edit the leaderboard message')));

    board.sentMsg.editMode = 'ok';
    check('press after the collector stopped is ignored', collector.press('⬅️', PRESSER) === false);
    await settle();
    check('no further edits after the collector stopped', board.sentMsg.edits.length === 1 && board.sentMsg.editAttempts === 2, 'edits: ' + board.sentMsg.edits.length + ', attempts: ' + board.sentMsg.editAttempts);
});

// 6. Errors and guides (Req 1.2, 2.4, 6.1)
scenario('errors & guides: DM resolves the exact guide string and sends nothing (Req 1.2)', async () => {
    installStatsFake(() => ({ err: 'unexpected osu! query in a DM' }));
    const channel = makeChannel('dm-channel');
    const msg = makeMsg(null, channel); // no guild = DM

    const result = await runCommand(msg, { 'u-1': 'Someone' });
    await settle();
    check('call resolves the exact DM guide string', result === 'This command can only be used in a server.', JSON.stringify(result));
    check('nothing is sent to the channel', channel.sends.length === 0, JSON.stringify(channel.sends));
    check('no stats queried in a DM', statsCalls.length === 0, String(statsCalls.length));
});

scenario('errors & guides: server with no linked players present -> ;ign-set guide, resolves null (Req 2.4)', async () => {
    installStatsFake(() => ({ err: 'unexpected osu! query' }));
    const guild = makeGuild('Empty Guild', ['u-stranger']); // linked user absent
    const channel = makeChannel('general');

    const result = await runCommand(makeMsg(guild, channel), { 'u-linked': 'LinkedPlayer' });
    await settle();
    check('call resolves null (the command owns its message)', result === null, String(result));
    check('exactly one message sent (the placeholder)', channel.sends.length === 1 && channel.sends[0] === 'Building leaderboard… 🔄', JSON.stringify(channel.sends));
    const sentMsg = channel.sentMsgs[0];
    const guide = sentMsg.edits[0];
    check('placeholder edited into the no-players guide', sentMsg.edits.length === 1 && typeof guide === 'string', JSON.stringify(guide));
    check('guide points at ;ign-set', guide.includes(';ign-set'), JSON.stringify(guide));
    check('guide text is exact', guide === 'No osu! players linked in this server yet. Link yours with **;ign-set <username>**.', JSON.stringify(guide));
    check('no navigation on the guide message', sentMsg.collectors.length === 0 && sentMsg.reacts.length === 0);
    check('no stats queried (nobody present)', statsCalls.length === 0, String(statsCalls.length));

    // same guide when the linked player IS present but osu! cannot resolve them
    const board2Guild = makeGuild('Ghost Guild', ['u-1']);
    const channel2 = makeChannel('general');
    installStatsFake(() => ({ stats: null })); // osu! user not found
    const result2 = await runCommand(makeMsg(board2Guild, channel2), { 'u-1': 'GhostPlayer' });
    await settle();
    check('unresolvable-only server resolves null too', result2 === null, String(result2));
    check('unresolvable-only server gets the same ;ign-set guide',
        channel2.sentMsgs[0].edits[0].includes(';ign-set'), JSON.stringify(channel2.sentMsgs[0].edits[0]));
});

scenario('errors & guides: osu! network failure deletes the placeholder and rejects with the standard error (Req 6.1)', async () => {
    installStatsFake(() => ({ err: "Couldn't reach osu!api. 💀" }));
    const guild = makeGuild('Net Guild', ['u-1']);
    const channel = makeChannel('general');

    let rejection = null;
    const result = await runCommand(makeMsg(guild, channel), { 'u-1': 'PlayerOne' }).catch(err => { rejection = err; return 'rejected'; });
    await settle();
    check('call rejected', result === 'rejected' && rejection !== null, String(rejection));
    check('rejection is the osu.js error string, unchanged', rejection === "Couldn't reach osu!api. 💀", String(rejection));
    const sentMsg = channel.sentMsgs[0];
    check('placeholder was sent first', channel.sends.length === 1 && channel.sends[0] === 'Building leaderboard… 🔄', JSON.stringify(channel.sends));
    check('placeholder deleted exactly once', sentMsg.deleted && sentMsg.deleteCalls === 1, 'deletes: ' + sentMsg.deleteCalls);
    check('placeholder never edited into content', sentMsg.edits.length === 0, 'edits: ' + sentMsg.edits.length);
    check('no navigation attached after the failure', sentMsg.collectors.length === 0 && sentMsg.reacts.length === 0);
    check('only the failing query was made', statsCalls.length === 1 && statsCalls[0] === 'PlayerOne', statsCalls.join(', '));
});

// 7. Indicator lifecycle (Req 8.1-8.4)
scenario('lifecycle: success -> the board edited over the placeholder, exactly one message from send to navigation (Req 8.1, 8.2)', async () => {
    const user_ign = { 'u-1': 'Alpha', 'u-2': 'Beta', 'u-3': 'Gamma' };
    const guild = makeGuild('Lifecycle Guild', Object.keys(user_ign));
    const channel = makeChannel('general');

    // scenario-local fake: remember how many sends existed when the first
    // stats query fired, proving the placeholder was on screen while the
    // leaderboard was still being built (Req 8.1)
    statsCalls.length = 0;
    let sendsAtFirstQuery = null;
    osu.get_user_stats = (options, cb) => {
        if(sendsAtFirstQuery === null)
            sendsAtFirstQuery = channel.sends.length;
        statsCalls.push(options.u);
        const pp = { Alpha: 300, Beta: 200, Gamma: 100 }[options.u];
        setImmediate(() => cb(null, makeStats('osu-' + options.u.toLowerCase(), options.u, pp, 1)));
    };

    const result = await runCommand(makeMsg(guild, channel), user_ign);
    await settle();
    const sentMsg = channel.sentMsgs[0];
    check('call resolves null (the command owns its single message)', result === null, String(result));
    check("the placeholder 'Building leaderboard… 🔄' was already on screen when the stats queries ran (Req 8.1)",
        sendsAtFirstQuery === 1 && channel.sends[0] === 'Building leaderboard… 🔄',
        'sends at first query: ' + sendsAtFirstQuery + ', first send: ' + JSON.stringify(channel.sends[0]));
    check('exactly one message exists in the channel (never a second send)', channel.sends.length === 1 && channel.sentMsgs.length === 1, 'sends: ' + channel.sends.length);
    check('the final board was edited onto the placeholder, not sent as a new message (Req 8.2)',
        sentMsg.edits.length === 1 && !!sentMsg.edits[0].embeds, 'edits: ' + sentMsg.edits.length);
    check('the final embed is the leaderboard of this guild',
        embedJson(sentMsg.edits[0]).title === 'Lifecycle Guild — osu! standard leaderboard', JSON.stringify(embedJson(sentMsg.edits[0]).title));
    check('every linked player was queried', statsCalls.length === 3 && statsCalls.includes('Alpha') && statsCalls.includes('Beta') && statsCalls.includes('Gamma'), statsCalls.join(', '));
    checkNoBuildingIndicator(channel, 'success');
});

scenario('lifecycle: empty server -> the placeholder becomes the ;ign-set guide, never deleted (Req 8.3)', async () => {
    installStatsFake(() => ({ err: 'unexpected osu! query' }));
    const guild = makeGuild('Empty Lifecycle Guild', ['u-stranger']); // the linked user is absent
    const channel = makeChannel('general');

    const result = await runCommand(makeMsg(guild, channel), { 'u-linked': 'LonelyPlayer' });
    await settle();
    const sentMsg = channel.sentMsgs[0];
    check('call resolves null (the command owns its message)', result === null, String(result));
    check('the placeholder was the only message sent', channel.sends.length === 1 && channel.sends[0] === 'Building leaderboard… 🔄', JSON.stringify(channel.sends));
    check('the placeholder was edited in place, never deleted', sentMsg.deleteCalls === 0 && !sentMsg.deleted, 'deletes: ' + sentMsg.deleteCalls);
    check('exactly one edit: the placeholder became the exact ;ign-set guide',
        sentMsg.edits.length === 1 && sentMsg.edits[0] === 'No osu! players linked in this server yet. Link yours with **;ign-set <username>**.',
        JSON.stringify(sentMsg.edits));
    check('no navigation on the guide message', sentMsg.collectors.length === 0 && sentMsg.reacts.length === 0);
    checkNoBuildingIndicator(channel, 'an empty server');
});

scenario('lifecycle: network failure -> the placeholder is deleted before the standard-error abort (Req 6.1, 8.4)', async () => {
    installStatsFake(() => ({ err: "Couldn't reach osu!api. 💀" }));
    const guild = makeGuild('Failing Lifecycle Guild', ['u-1']);
    const channel = makeChannel('general');

    let rejection = null;
    let deletedAtRejection = null;
    const result = await runCommand(makeMsg(guild, channel), { 'u-1': 'DoomedPlayer' }).catch(err => {
        // observed the moment the command rejects: the delete double only
        // marks the message deleted after an awaited round trip, so a reject
        // that does not wait for the delete would still see deleted === false
        rejection = err;
        deletedAtRejection = channel.sentMsgs[0].deleted;
        return 'rejected';
    });
    await settle();
    const sentMsg = channel.sentMsgs[0];
    check('call rejected with the osu.js error string, unchanged (Req 6.1)', result === 'rejected' && rejection === "Couldn't reach osu!api. 💀", String(rejection));
    check('the placeholder was already deleted when the rejection surfaced (delete strictly before abort)', deletedAtRejection === true, String(deletedAtRejection));
    check('the placeholder was deleted exactly once', sentMsg.deleted && sentMsg.deleteCalls === 1, 'deletes: ' + sentMsg.deleteCalls);
    check('the placeholder was never edited into content', sentMsg.edits.length === 0, 'edits: ' + sentMsg.edits.length);
    check('no navigation attached after the failure', sentMsg.collectors.length === 0 && sentMsg.reacts.length === 0);
    check('only the failing query was made', statsCalls.length === 1 && statsCalls[0] === 'DoomedPlayer', statsCalls.join(', '));
    checkNoBuildingIndicator(channel, 'a network failure');
});

scenario('harness integrity: no unhandled rejections from background navigation', async () => {
    check('no unhandled rejections across all scenarios', unhandledRejections.length === 0, unhandledRejections.join(' | '));
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

(async () => {
    for(const { name, fn } of scenarios) {
        currentScenario = { name, checks: [], logStart: helperMessages.length };
        try {
            await fn();
        } catch(err) {
            check('scenario body completed without throwing', false, (err && err.stack) || String(err));
        }
        const failed = currentScenario.checks.filter(c => !c.ok);
        scenarioResults.push({ name, ok: failed.length === 0 });
        if(failed.length === 0) {
            console.log(`PASS ${name} (${currentScenario.checks.length} checks)`);
        } else {
            console.log(`FAIL ${name}`);
            for(const c of failed)
                console.log(`  - ${c.name}${c.detail !== undefined ? ' [' + c.detail + ']' : ''}`);
            const newLogs = helperMessages.slice(currentScenario.logStart);
            if(newLogs.length)
                console.log('  helper log:\n' + newLogs.map(l => '    ' + l).join('\n'));
        }
    }
    const passed = scenarioResults.filter(r => r.ok).length;
    console.log(`\n${passed}/${scenarioResults.length} scenarios passed (${totalChecks - failedChecks}/${totalChecks} checks)`);
    process.exit(passed === scenarioResults.length ? 0 : 1);
})();
