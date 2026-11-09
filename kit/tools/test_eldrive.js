'use strict';

// elDrive (apps/eldrive: eDrive with fully electric cars) against stubbed kit modules (mgu, the diagnostic link) and a
// clock moved by hand: every check of the upstream eDrive's test_edrive.js (plug-in hybrids, 48 V, 12 V as in eDrive), then the fully
// electric ones, with the battery unit answering as captured on iX3s (OBDb/BMW-iX3: DDBC zero bytes, the charge in
// E5CE, kWh in E5C7, DD68 / DD69 / 6335 refused). No SDK, vehicle or capture needed:
//   node kit/tools/test_eldrive.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'eldrive', 'main.js'), LIVE = path.join(ROOT, 'apps', 'eldrive', 'live.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'eldrive', 'app.json'), 'utf8'));
const { Recorder: Canvas } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

// the clock, and timers that only run when a test fires them
let now = Date.UTC(2026, 9, 1, 18);
Date.now = () => now;
let timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
global.clearTimeout = (t) => { timers = timers.filter((x) => x !== t); };
global.setInterval = () => 0;
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const fire = async (pred) => {
    const t = timers.filter((x) => pred(x.ms)).pop();
    assert(t, 'timer scheduled');
    timers = timers.filter((x) => x !== t);
    t.fn(); await flush();
};

// the kit modules: './kit/x' from kit/runtime, the SDK-bound ones stubbed
let app = null, diag = null, reader = null, values = {};
class FakeDiag extends EventEmitter { constructor() { super(); this.available = false; diag = this; } init() {} }
// the battery unit's values by name; other units (the 48 V battery, the converter, the engine unit's 12 V
// sensor) answer `replies` by '<ecu>:<DID>' (the data after the DID, hex), through the real reader
let replies = {};
// waitNoReply: a unit that doesn't answer takes its whole timeout (the clock moves on by it), as on the car;
// asked: the units asked, in order
let waitNoReply = false, asked = [];
const RealReader = require(path.join(KIT, 'dids')).DidReader;
class FakeReader extends RealReader {
    constructor() {
        super({ physical: async (ecu, sid, req, timeoutMs) => {
            asked.push(ecu);
            const did = ((req[0] << 8) | req[1]).toString(16).toUpperCase().padStart(4, '0'), r = replies[ecu + ':' + did];
            // (a reply starting with 7F is a refusal as it comes: '7F 22 31')
            if (r) return /^7F /.test(r) ? r.split(' ').map((x) => parseInt(x, 16)) : [0x62, req[0], req[1]].concat(r.split(' ').map((x) => parseInt(x, 16)));
            // the battery unit (0x07) is there while the test gives it a charge value (null: no reading now)
            if (ecu === 7 && values.soc !== undefined) {
                return did === 'DDBC' && typeof values.soc === 'number' ? [0x62, req[0], req[1], (values.soc * 10) >> 8, (values.soc * 10) & 0xFF] : [0x7F, sid, 0x31];
            }
            if (waitNoReply) now += timeoutMs || 4000;
            return null;
        } }, { ecu: 7 });
        reader = this;
    }
    async value(key, list) {
        // the battery unit answering `replies` (a fully electric car's): its values through the real reader too
        const real = Object.keys(replies).some((k) => k.indexOf('7:') === 0);
        if (values[key] === undefined && (real || (list || []).some((c) => c.ecu != null && c.ecu !== 7))) return super.value(key, list);
        if (values[key] === undefined) (list || []).forEach((c) => { this.raws[this.key(c)] = { why: 'no reply', bytes: '' }; });
        return values[key] === undefined ? null : values[key];
    }
}
const stubs = {
    './kit/mgu': { run(a) { app = a; } },
    './kit/diag': { Diag: FakeDiag, hex: require(path.join(KIT, 'diag')).hex },
    './kit/dids': { DidReader: FakeReader },
};
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

const dirs = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edrive-' + name + '-')); dirs.push(d); return d; };
// (warnings kept: how long a read held the diagnostic link, main.js pump)
const warnings = [];
const quiet = { info() {}, warn(m) { warnings.push(String(m)); }, error() {} };
function context(dir, set) {
    const defaults = {};
    SPEC.settings.forEach((s) => { defaults[s.key] = s.default; });
    const S = Object.assign(defaults, { demo: 'off' }, set || {});
    const clicks = {}, texts = [], watchers = {};
    return {
        clicks, texts, watchers, ui: { onClick: (id, fn) => { clicks[id] = fn; }, text() {}, image: async () => {} },
        settings: { get: (k) => S[k], onChange() {} },
        log: quiet, spec: SPEC, dataDir: dir,
        signals: { watch: (iface, ver, handlers) => { Object.assign(watchers, handlers); return Promise.resolve({}); } },
        onTab() {}, hideButton() {}, onScroll() {}, loop(name, fps, fn) { this.frame = fn; },
        theme: () => themes.theme('m_tricolour'), canvas: (w, h) => {
            const cv = new Canvas(w, h), text = cv.text.bind(cv);
            cv.text = (str, x, y, size, color, opts) => {
                const width = text(str, x, y, size, color, opts);
                texts.push({ str: String(str), x, y, width });
                return width;
            };
            return cv;
        },
    };
}

/**
 * One start of eDrive (a fresh process): the battery unit answers `vals`; read() is one poll, readNow() the
 * "Read now" button (the health read too), exit() the process exiting (its exit handlers only: kept off this process's)
 */
async function boot(dir, vals, set) {
    [MAIN, LIVE, path.join(ROOT, 'apps', 'eldrive', 'range.js')].forEach((f) => { delete require.cache[f]; });
    require(MAIN);
    values = vals; timers = [];
    const ctx = context(dir, set), before = process.listeners('exit');
    await app.start(ctx);
    const onExit = process.listeners('exit').filter((f) => before.indexOf(f) < 0);
    onExit.forEach((f) => process.removeListener('exit', f));
    await flush();
    return {
        texts: ctx.texts, reader,
        page: async () => { await ctx.clicks.BTN_PAGE(); await flush(); },
        read: async () => { diag.available = true; diag.emit('available', true); await flush(); },
        readNow: async () => { diag.available = true; ctx.clicks.BTN_READ(); await flush(); },
        draw: async () => { ctx.texts.length = 0; await ctx.frame(); return ctx.texts.map((x) => x.str); },
        drive: (kmh) => ctx.watchers.statusCarSpeed2({ speedVehicleCentreOfGravity: kmh / 0.015625 }),
        signal: (name, v) => ctx.watchers[name](v),
        exit: () => onExit.forEach((f) => f(0)),
    };
}
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'battery.json'), 'utf8'));

/** eDrive Live (live.js) on its own, with eDrive's live values L; the battery unit answers `vals` by DID. extra: more of
 *  what main.js hands it (isBev, fullKwh). */
function startLive(dir, L, vals, config, extra) {
    delete require.cache[LIVE];
    timers = [];
    const raws = {};
    const reader = {
        raws, key: (p) => p.did,
        async read(p) {
            const v = vals[p.did];
            if (v === undefined) return null;
            raws[p.did] = { bytes: '62 ' + p.did.slice(0, 2) + ' ' + p.did.slice(2) + ' 00 00' };
            return v;
        },
    };
    const ctx = context(dir);
    ctx.spec = { config: Object.assign({ battery: { fast: { hvV: [{ did: 'DD68', fields: { v: {} } }], hvI: [{ did: 'DD69', fields: { a: {} } }] }, slow: {} } }, config || {}) };
    const exclusive = (fn) => fn();
    return require(LIVE)(ctx, Object.assign({ diag: { available: true, on() {}, physical: async () => null }, reader, exclusive, live: L, page: () => 'main', climateKw: () => 0 }, extra || {}));
}

/* A fully electric car's battery unit as captured on iX3s (OBDb/BMW-iX3, 2021-2023): DDBC answers zero bytes, the charge
 * is in E5CE (0.01 %, then the lowest and highest cell's), E5C7 holds the energy stored and usable (kWh, 0.01, -50),
 * the hybrids' identifiers are refused. hex4: a 2-byte word as the replies write it. */
const hex4 = (v) => { const n = Math.round(v) & 0xFFFF; return [n >> 8, n & 255].map((x) => ('0' + x.toString(16).toUpperCase()).slice(-2)).join(' '); };
const IX3 = (soc, stored, cap) => ({
    '7:DDBC': '00 00 00 00 00 00',
    '7:E5CE': hex4(soc * 100) + ' ' + hex4(soc * 100 - 30) + ' ' + hex4(soc * 100 + 20),
    '7:E5C7': hex4((stored + 50) * 100) + ' ' + hex4((cap + 50) * 100),
    '7:DD68': '7F 22 31', '7:DD69': '7F 22 31', '7:6335': '7F 22 31', '7:DDBF': '7F 22 31', '7:DD7B': '7F 22 31',
});
const power = () => fire((ms) => ms === 60 || ms === 2000);
const liveState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')); } catch (e) { return {}; } };
const L0 = () => ({ speed: 0, rpm: 0, rpmT: 0, climate: false, seats: {}, wheel: false, standSince: now - 60000, blower: 0, blowerTop: 8, ambient: 10 });

const checks = [
    ['1. charge logged once across restarts', async () => {
        // a charge done while the head unit slept stays open until the car drives off, then is logged once: each
        // start keeps the charge it read, even when the head unit goes off within 2 min (before the next timed save)
        const dir = tmp('charge');
        let b = await boot(dir, { soc: 20, soh: 90, v12: 12.5 });
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 20);
        now += 10 * 3600000;                                     // overnight on the charger
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        assert.deepStrictEqual([state(dir).log, state(dir).session.from, state(dir).session.to], [undefined, 20, 90],
            'the charge is open until the car drives off');
        assert.strictEqual(state(dir).lastSoc, 90, 'battery.json keeps the charge read');
        now += 3600000;                                          // switched off a minute later, on again an hour on
        b = await boot(dir, { soc: 90, soh: 90, v12: 12.5 });
        await b.read();
        b.drive(30); values.soc = 89.8; now += 30000;
        await b.read();
        assert.deepStrictEqual(state(dir).log.map((c) => [c.from, c.to]), [[20, 90]], 'driving off logs the charge once');
        // the diagnostic link back after 10 min while charging, a save (the health read) just before: the charge
        // read by the next reading is saved with it, not left to the 2 min timer
        b.drive(0); values.soc = null; now += 10 * 60000;
        await b.readNow();                                       // no charge reading, health read and saved
        values.soc = 97; now += 30000;
        await b.read();
        assert.deepStrictEqual([state(dir).session.from, state(dir).session.to, state(dir).lastSoc], [89.8, 97, 97],
            'the second charge is saved with its reading');
        b.drive(30); values.soc = 96.5; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).log.length, 2, 'the second charge is logged');
        // the head unit switched off: the reading the 2 min timer has not saved yet goes with the exit
        values.soc = 96.3; now += 30000;
        await b.read();
        assert.strictEqual(state(dir).lastSoc, 96.5);
        b.exit();
        assert.strictEqual(state(dir).lastSoc, 96.3, 'saved on exit');
    }],
    ['1c. one charge across the car waking during it', async () => {
        // plugged in at 7 %, the car wakes now and then while it charges (24 %, 70 %, 100 %): one charge, 7 % to 100 %
        const dir = tmp('wakes');
        let b = await boot(dir, { soc: 7, soh: 90, v12: 12.5 });
        await b.read();
        for (const soc of [24, 24.6, 70, 100]) {
            now += soc === 24.6 ? 30000 : 2 * 3600000;           // 24.6: read while still awake
            if (soc !== 24.6) b = await boot(dir, { soc, soh: 90, v12: 12.5 });
            values.soc = soc;
            await b.read();
        }
        assert.strictEqual(state(dir).log, undefined, 'nothing logged while parked');
        now += 3600000;
        b = await boot(dir, { soc: 100, soh: 90, v12: 12.5 });
        b.drive(40);
        await b.read();
        assert.deepStrictEqual(state(dir).log.map((c) => [c.from, c.to]), [[7, 100]], 'one charge, 7 % to 100 %');
    }],
    ['1b. nothing to save: no file on exit', async () => {
        // demo / no hybrid system: nothing read, so the exit writes nothing (no battery.json on a first run)
        const dir = tmp('idle');
        const b = await boot(dir, {});
        b.exit();
        assert(!fs.existsSync(path.join(dir, 'battery.json')), 'no battery.json written');
    }],
    ['2. baseline without seat / wheel heating', async () => {
        // the on-board baseline is learned only with seat and steering-wheel heating off (eDrive's values, L)
        const dir = tmp('base');
        startLive(dir, Object.assign(L0(), { seats: { DR: 3 }, wheel: true }), { DD68: 350, DD69: -3 });   // 1.05 kW, heating on
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        assert.strictEqual(liveState(dir).baseKw, undefined, 'seat / wheel heating kept out of the baseline');
        startLive(dir, L0(), { DD68: 350, DD69: -1 });                                                    // 0.35 kW, all off
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        assert(Math.abs(liveState(dir).baseKw - 0.35) < 1e-9, 'baseline learned with everything off');
    }],
    ['3. kWh without a health reading', async () => {
        // no health reading yet (first run, or a car whose SOH read fails): the charge still has its energy, at
        // 100 % health as the range uses (kwhPerPct)
        const dir = tmp('nosoh');
        let b = await boot(dir, { soc: 30, soh: null, v12: 12.5 });
        await b.read();
        now += 8 * 3600000;
        b = await boot(dir, { soc: 80, soh: null, v12: 12.5 });
        b.drive(30);
        await b.read();
        const c = state(dir).log[0];
        assert(c && typeof c.kwh === 'number', 'logged charge has kWh: ' + JSON.stringify(c));
        assert(Math.abs(c.kwh - 50 / 100 * SPEC.settings.find((s) => s.key === 'designKwh').default) < 1e-9);
    }],
    ['4. use and otherKw saved on their own', async () => {
        // measured consumption (st.use) is kept across restarts: driving, climate on, so the baseline never learns
        let dir = tmp('use');
        const L = Object.assign(L0(), { speed: 50, climate: 'ac', standSince: 0 });
        let lv = startLive(dir, L, { DD68: 350, DD69: -30 });      // 10.5 kW at 50 km/h
        for (let i = 0; i < 5; i++) { now += 2000; await power(); }
        assert(lv.consumption().km > 0);
        assert(liveState(dir).use && liveState(dir).use.km > 0, 'st.use saved: ' + JSON.stringify(liveState(dir)));
        lv = startLive(dir, L, { DD68: 350, DD69: -30 });
        assert(lv.consumption().km > 0, 'st.use back after a restart');
        // the climate's other draw (st.otherKw): standing, climate on, the climate unit's compressor figure
        dir = tmp('other');
        const probes = [{ name: 'ac', ecu: 120, did: 'D8D2', factor: 0.001 }];
        lv = startLive(dir, Object.assign(L0(), { climate: 'ac' }), { DD68: 400, DD69: -5, D8D2: 1000 }, { probes });   // 2 kW, compressor 1 kW
        now += 2000; await power();
        lv.draw('battery', new Canvas(1600, 520), themes.theme('m_tricolour'));    // the page shown: the slow reads run
        await fire((ms) => ms === 5000);
        // 2 kW - the 0.35 kW baseline - 1 kW compressor
        assert(Math.abs(liveState(dir).otherKw - 0.65) < 1e-9, 'st.otherKw saved: ' + JSON.stringify(liveState(dir)));
    }],
    ['4b. driving saves live.json every 5 min (flash), the rest at shutdown', async () => {
        const dir = tmp('use5'), L = Object.assign(L0(), { speed: 50, climate: 'ac', standSince: 0 });
        const before = process.listeners('exit').length;
        startLive(dir, L, { DD68: 350, DD69: -30 });
        const atExit = process.listeners('exit').slice(before);
        for (let i = 0; i < 5; i++) { now += 2000; await power(); }
        const km0 = (liveState(dir).use || {}).km;
        assert(km0 > 0, 'the first measurement saved');
        for (let i = 0; i < 120; i++) { now += 2000; await power(); }        // 4 min more
        assert.strictEqual(liveState(dir).use.km, km0, 'live.json written more often than every 5 min');
        atExit.forEach((fn) => fn());                                       // MainApp's shutdown
        assert(liveState(dir).use.km > km0, 'the last minutes lost at shutdown');
        process.removeListener('exit', atExit[0]);
    }],
    ['5. plural forms come from the locale catalogs', async () => {
        const { plural, PLURAL_RULES } = require(path.join(KIT, 'i18n'));
        const ru = require(path.join(KIT, 'locales', 'ru.json'));
        const form = (catalog, lang, n, one, other) => catalog[one + '|' + other].split('|')[PLURAL_RULES[lang](n)];
        const cases = [[0, 2], [1, 0], [2, 1], [4, 1], [5, 2], [11, 2], [12, 2], [13, 2], [14, 2],
            [21, 0], [22, 1], [24, 1], [25, 2], [101, 0], [102, 1], [105, 2], [111, 2], [114, 2]];
        const faults = ['ошибка', 'ошибки', 'ошибок'], charges = ['зарядка', 'зарядки', 'зарядок'];
        cases.forEach(([n, i]) => {
            assert.strictEqual(form(ru, 'ru', n, 'fault', 'faults'), faults[i], n + ' faults');
            assert.strictEqual(form(ru, 'ru', n, 'charge', 'charges'), charges[i], n + ' charges');
        });
        [0, 1, 2, 11, 21].forEach((n) => {
            assert.strictEqual(plural(n, 'fault', 'faults'), n === 1 ? 'fault' : 'faults');
            assert.strictEqual(plural(n, 'not', 'in catalog', 'ru'), n === 1 ? 'not' : 'in catalog', 'missing row falls back to English');
        });
    }],
    ['6. English diagnostic status keeps its layout (Russian alone moves and fits the column)', async () => {
        const b = await boot(tmp('status-width'), {}, { diagPage: true });
        b.reader.raws[b.reader.key(SPEC.config.battery.soc[0])] = { why: 'WWWWWWWWWWWWWWWWWWWWWWWWWW', t: now };
        for (let i = 0; i < 3; i++) await b.page();
        b.texts.length = 0;
        await b.page();
        const status = b.texts.find((x) => x.x === 1000 && x.y > 178), read = b.texts.find((x) => x.x === 1290 && x.y > 178);
        assert(status && read, 'diagnostic status and read cells drawn');
        assert.strictEqual(status.str, 'W'.repeat(23) + '…', 'English status cut at 24 characters as before');
    }],
    ['8. a 48 V mild hybrid: found by itself, its own page only', async () => {
        // no high-voltage battery (the battery unit never answers), the 48 V battery and its converter do
        const dir = tmp('mild');
        replies = {
            '2:AA56': '12 84 FF 88 00 30 08 0F C3 50 C2 EC 00 00 3E 5A 12 82 6E 25 2E 00 6A 68 00 00 60 58',
            '84:DA90': '37 14 B9 28 01 54 FF 97 01 E0 FE 0E 09',
            '18:5852': '27 88', '18:56F0': '54', '18:59AA': '5C', '18:5854': '59', '18:4604': '01 40',
        };
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off' });
        for (let i = 0; i < 4; i++) { now += 20000; await b.read(); }
        assert.deepStrictEqual([state(dir).noHybrid, state(dir).mild48], [true, true], JSON.stringify(state(dir)));
        const t = await b.draw();
        assert(t.includes('48 V SYSTEM') && !t.includes('RANGE') && !t.includes('CHARGE LOG'), t.join(' | '));
        ['62', '47.4 V', '-0.57 kW', '96 %', 'CHARGING', 'Charging 12 V', '14.1 V   +34.0 A   +480 W', '47.4 V   -10.5 A   -498 W']
            .forEach((s) => assert(t.some((x) => x.includes(s)), s + ' in ' + t.join(' | ')));
        // Details: what the battery reports about its life
        await b.page();
        const det = await b.draw();
        ['412.6 kWh', '5000.0 Ah', '4990.0 Ah', '47.38 V', '11.0 Ah', '10.6 Ah', '10.4 Ah', '11.50 mOhm', '9.25 mOhm', '90 % · 88 %']
            .forEach((x) => assert(det.includes(x), x + ' in ' + det.join(' | ')));
        assert(det.includes('DETAILS'), 'the Details tab');
        // remembered: the next start shows the 48 V page before anything is read
        const b2 = await boot(dir, {}, { demo: 'off' });
        assert((await b2.draw()).includes('48 V SYSTEM'));
        replies = {};
    }],
    ['9b. the 12 V charge from the car signal when the battery sensor does not answer', async () => {
        const dir = tmp('signal');
        replies = {};
        const b = await boot(dir, { v12: 12.5 }, { demo: 'off', hybrid: 'no' });
        b.signal('statusBattery2', { conditionBatteryChargingCondition: 77 });
        now += 20000; await b.read();
        const t = await b.draw();
        assert(t.includes('77 %'), 'the car signal\'s charge: ' + t.join(' | '));
    }],
    ['9. no hybrid system: the 12 V battery with the battery sensor\'s values', async () => {
        const dir = tmp('none');
        replies = { '18:5852': '27 88', '18:56F0': '54', '18:59AA': '5C', '18:5854': '59', '18:4604': '01 40' };
        const b = await boot(dir, { v12: 12.5 }, { demo: 'off' });
        for (let i = 0; i < 7; i++) { now += 20000; await b.read(); }
        assert.deepStrictEqual([state(dir).noHybrid, state(dir).no48, !!state(dir).mild48], [true, true, false], JSON.stringify(state(dir)));
        const t = await b.draw();
        assert(t.includes('12 V BATTERY') && t.includes('CURRENT') && !t.includes('48 V SYSTEM'), t.join(' | '));
        ['+2.4 A', '84 %', '92 %', '40 A', 'No hybrid system answered.'].forEach((s) => assert(t.includes(s), s + ' in ' + t.join(' | ')));
        replies = {};
    }],
    ['10. a plug-in hybrid stays as it is; the setting picks the system', async () => {
        const dir = tmp('phev');
        const b = await boot(dir, { soc: 55, soh: 90, v12: 12.5 }, { demo: 'off' });
        for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        assert(!state(dir).noHybrid && !state(dir).mild48, JSON.stringify(state(dir)));
        assert((await b.draw()).includes('RANGE'));
        assert((await (await boot(dir, {}, { demo: 'off', hybrid: '48v' })).draw()).includes('48 V SYSTEM'));
        assert((await (await boot(dir, {}, { demo: 'off', hybrid: 'no' })).draw()).includes('ALTERNATOR'));
    }],
    ['7. charge totals keep English singular and plural', async () => {
        const dir = tmp('charge-counts'), today = new Date(), current = today.getTime();
        const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime();
        const log = Array.from({ length: 21 }, (_, i) => ({ from: 10, to: 20, fromT: current - 3600000, toT: i ? previous - i * 1000 : current, kwh: 1 }));
        fs.writeFileSync(path.join(dir, 'battery.json'), JSON.stringify({ log }));
        const b = await boot(dir, {});
        assert.strictEqual(state(dir).log.length, 21, 'saved charge log loaded');
        for (let i = 0; i < 2; i++) await b.page();
        b.texts.length = 0;
        await b.page();
        const month = b.texts.find((x) => x.x === 1552 && x.y === 116), all = b.texts.find((x) => x.x === 1552 && x.y === 208);
        assert(month && /^1 charge  ·  \+/.test(month.str), month && month.str);
        assert(all && /^21 charges  ·  \+/.test(all.str), all && all.str);
    }],

    /* ---------- fully electric (BEV) ---------- */
    ['B1. an iX3 found by itself: the charge from E5CE (never DDBC\'s zeros), its kWh from E5C7, no engine', async () => {
        const dir = tmp('ix3');
        // the replies as captured on a 2023 iX3: 86.86 %, 62.30 kWh stored, 74.21 kWh usable
        replies = Object.assign(IX3(0, 0, 0), { '7:E5CE': '21 EE 21 D9 21 FD', '7:E5C7': '2B DE 30 85' });
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off' });
        for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        const s = state(dir);
        assert.deepStrictEqual([s.hybrid, s.bev, s.lastSoc, s.cap], [true, true, 86.86, 74.2], JSON.stringify(s));
        assert.strictEqual(b.reader.raws['7:DDBC'].why, 'out of range', 'DDBC\'s zero is not a charge');
        const t = await b.draw();
        ['87', 'down to 0 %', '62.3', ' / 74.2'].forEach((x) => assert(t.includes(x), x + ' in ' + t.join(' | ')));
        assert(!t.some((x) => /HYBRID|ENGINE|engine/.test(x)), 'nothing about an engine: ' + t.join(' | '));
        // before any driving is learned: 74.21 kWh at 19.5 kWh / 100 km (10 °C: no outside temperature) x 86.86 %
        const big = b.texts.find((x) => x.x === 48 && x.y === 196);
        assert.strictEqual(big && big.str, String(Math.round(74.21 / 0.195 * 0.8686)), 'range ' + (big && big.str));
        replies = {};
    }],
    ['B2. DDBC\'s zeros are never an empty battery, also when E5CE misses a reading', async () => {
        const dir = tmp('zeros');
        replies = IX3(55, 40.7, 73.5);
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off', hybrid: 'bev' });
        now += 20000; await b.read();
        assert.strictEqual(state(dir).lastSoc, 55);
        assert.strictEqual(b.reader.pick.soc, 1, 'E5CE picked');
        delete replies['7:E5CE'];
        now += 20000; await b.read();
        b.exit();                                            // (the reading saved now, not at the next 2 min save)
        assert.strictEqual(state(dir).lastSoc, 55, 'no reading rather than 0 %');
        assert.strictEqual(b.reader.pick.soc, 1, 'still E5CE, not DDBC');
        replies['7:E5CE'] = IX3(54.8, 0, 0)['7:E5CE'];
        now += 20000; await b.read();
        b.exit();
        assert(Math.abs(state(dir).lastSoc - 54.8) < 1e-9, 'back to E5CE: ' + state(dir).lastSoc);
        replies = {};
    }],
    ['B3. fully electric: learns from driving without an engine signal; the motor\'s speed is no engine', async () => {
        // 12.5 km in town at 50 km/h and 14 kWh / 100 km: 0.17 % per km after the on-board draw, under the hybrid's
        // 0.2 % per km floor (range.js scale)
        const dir = tmp('learn');
        let soc = 80;
        replies = IX3(soc, soc * 0.74, 74);
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off', hybrid: 'bev' });
        b.drive(50); now += 1000; await b.read();
        for (let i = 0; i < 60; i++) {
            for (let k = 0; k < 15; k++) { now += 1000; b.drive(50); }
            soc -= 50 * 15 / 3600 * 0.14 / 0.74;
            Object.assign(replies, IX3(soc, soc * 0.74, 74));
            await b.read();
        }
        b.exit();                                            // (what it learned saved now, not at the next 2 min save)
        const s = state(dir);
        assert(s.learn && s.learn.km > 12 && !s.engineStarts, JSON.stringify(s));
        b.signal('statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 6000 / 0.25 });   // a motor at 6000 rpm
        const t = await b.draw();
        assert(!t.some((x) => /ENGINE|engine/.test(x)), t.join(' | '));
        assert(t.some((x) => /^learned from 1[23] km$/.test(x)), t.join(' | '));
        // the range at what it learned: what is left over 14 kWh / 100 km (the on-board draw at 50 km/h included)
        const big = b.texts.find((x) => x.x === 48 && x.y === 196), want = soc * 0.74 / 0.14;
        assert(big && Math.abs(+big.str - want) <= 3, big && big.str + ' vs ' + want.toFixed(1));
        replies = {};
    }],
    ['B4. a slow charge while awake is logged (AC, or 50 kW on a big battery: under 0.3 % per reading)', async () => {
        const dir = tmp('slow');
        let soc = 40;
        replies = IX3(soc, soc * 0.74, 74);
        const b = await boot(dir, { v12: 12.6 }, { demo: 'off', hybrid: 'bev' });
        b.drive(0); now += 1000; await b.read();
        for (let i = 0; i < 70; i++) {                         // 11 kW: +0.06 % every 15 s
            now += 15000; b.drive(0); soc += 11 * 15 / 3600 / 0.74;
            Object.assign(replies, IX3(soc, soc * 0.74, 74)); await b.read();
        }
        assert(state(dir).session && state(dir).session.from === 40, JSON.stringify(state(dir).session));
        b.drive(30); now += 15000; await b.read();
        const log = state(dir).log, to = Math.round(soc * 100) / 100;
        assert.deepStrictEqual(log.map((c) => [c.from, c.to]), [[40, to]], JSON.stringify(log));
        assert(Math.abs(log[0].kwh - (to - 40) * 0.74) < 1e-6, 'kWh from the usable kWh: ' + log[0].kwh);
        replies = {};
    }],
    ['B5. fully electric live power: E561 x E54D, else a voltage estimated from the charge', async () => {
        const bat = SPEC.config.battery, config = { battery: { fast: bat.fast, slow: {}, powerSign: bat.powerSign, packV: bat.packV } };
        const L = () => Object.assign(L0(), { speed: 50, standSince: 0, soc: 50 });
        const cv = () => new Canvas(1600, 520), th = themes.theme('m_tricolour');
        let lv = startLive(tmp('bevpower'), L(), { E54D: 376.46, E561: -79.13 }, config, { isBev: () => true });
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        let d = lv.draw('battery', cv(), th);
        assert(Math.abs(d.kw - 376.46 * 79.13 / 1000) < 1e-6 && !d.vEst, JSON.stringify([d.kw, d.v, d.vEst]));
        lv = startLive(tmp('bevest'), L(), { E561: -79.13 }, config, { isBev: () => true });
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        d = lv.draw('battery', cv(), th);
        const v = bat.packV.empty + (bat.packV.full - bat.packV.empty) * 0.5;
        assert(d.vEst && Math.abs(d.v - v) < 1e-9 && Math.abs(d.kw - v * 79.13 / 1000) < 1e-6, JSON.stringify([d.kw, d.v, d.vEst]));
        // a plug-in hybrid without a voltage: no estimate, as in eDrive
        lv = startLive(tmp('phevnov'), L(), { E561: -79.13 }, config, { isBev: () => false });
        for (let i = 0; i < 3; i++) { now += 2000; await power(); }
        d = lv.draw('battery', cv(), th);
        assert(d.kw === null && d.v === null, JSON.stringify([d.kw, d.v]));
    }],
    ['B6. the settings per drive system', async () => {
        const offered = (hybrid) => {
            const v = {};
            SPEC.settings.forEach((s) => { v[s.key] = s.default; });
            v.hybrid = hybrid;
            return SPEC.settings.filter((s) => !s.hidden && (!s.when || Object.keys(s.when).every((k) => [].concat(s.when[k]).indexOf(v[k]) >= 0))).map((s) => s.key);
        };
        const BEV = ['designKwhBev', 'bevReserve', 'price'], PHEV = ['range20', 'reserve', 'designKwh', 'price'];
        BEV.forEach((k) => assert(offered('bev').includes(k) && offered('auto').includes(k), k));
        ['range20', 'reserve', 'designKwh'].forEach((k) => assert(!offered('bev').includes(k), 'no ' + k + ' on a fully electric car'));
        PHEV.forEach((k) => assert(offered('yes').includes(k), k));
        ['designKwhBev', 'bevReserve'].forEach((k) => assert(!offered('yes').includes(k) && !offered('48v').includes(k), 'no ' + k));
        assert.deepStrictEqual(SPEC.settings.find((s) => s.key === 'hybrid').options.map((o) => o[0]), ['auto', 'bev', 'yes', '48v', 'no']);
    }],
    ['B7. the range model\'s limits scale with the battery (the hybrid\'s as they were)', async () => {
        const { RangeModel } = require(path.join(ROOT, 'apps', 'eldrive', 'range.js'));
        const m = new RangeModel({ learn: { km: 20, pct: 20 * 0.17 } });
        assert.strictEqual(m.drivePctPerKm(50), null, '0.17 % per km is under the hybrid\'s floor');
        m.scale = 0.12 / 0.74;
        assert(Math.abs(m.drivePctPerKm(50) - 0.17) < 1e-9);
    }],
    ['B8. "range counts down to" 10 %', async () => {
        replies = IX3(50, 37, 74);
        const b = await boot(tmp('reserve'), { v12: 12.6 }, { demo: 'off', hybrid: 'bev', bevReserve: '10' });
        now += 20000; await b.read();
        const t = await b.draw(), big = b.texts.find((x) => x.x === 48 && x.y === 196);
        assert(t.includes('down to 10 %'), t.join(' | '));
        assert.strictEqual(big && big.str, String(Math.round(40 * 0.74 / 0.195)), 'the 40 % above 10 %: ' + (big && big.str));
        replies = {};
    }],
    ['B10. a 12 V read that nobody answers never holds the link long (the live power reads between)', async () => {
        // an iX3 whose battery unit refuses F442 and has no engine or gearbox unit: before, all nine 12 V candidates
        // went in one turn on the link (27 s of timeouts), the live power waited behind it and blanked after 15 s
        const held = () => warnings.map((w) => /^link held (\d+) ms by (.*)$/.exec(w)).filter(Boolean).map((m) => [+m[1], m[2]]);
        replies = Object.assign(IX3(62, 45.9, 74), { '7:F442': '7F 22 31' });
        waitNoReply = true; warnings.length = 0; asked = [];
        const b = await boot(tmp('v12'), {}, { demo: 'off', hybrid: 'bev' });
        for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        waitNoReply = false;
        const longest = Math.max.apply(null, [0].concat(held().map((h) => h[0])));
        assert(longest <= 4000, 'a turn held the link ' + longest + ' ms: ' + JSON.stringify(held()));
        [0x12, 0x13, 0x18].forEach((u) => assert(asked.indexOf(u) < 0, 'unit 0x' + u.toString(16) + ' asked on a fully electric car'));
        assert(asked.indexOf(0x40) >= 0 && asked.indexOf(0x1A) >= 0, 'the fully electric candidates are still asked');
        void b;
        // a plug-in hybrid still asks its engine unit first after the battery unit (as configured)
        replies = {}; asked = [];
        const p = await boot(tmp('v12-phev'), { soc: 55 }, { demo: 'off', hybrid: 'yes' });
        now += 20000; await p.read();
        assert(asked.indexOf(0x12) >= 0, 'the engine unit asked on a plug-in hybrid: ' + asked.join(','));
    }],
    ['B9. a plug-in hybrid on Auto stays one (its battery unit refuses E5C7)', async () => {
        const dir = tmp('phev-auto');
        const b = await boot(dir, { soc: 55, soh: 90, v12: 12.5 }, { demo: 'off' });
        for (let i = 0; i < 3; i++) { now += 20000; await b.read(); }
        assert.strictEqual(state(dir).bev, false, JSON.stringify(state(dir)));
        assert((await b.draw()).includes('engine starts at 11 %'));
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    if (failed.length) process.exit(1);
    console.log('elDrive: eDrive\'s checks passed (charge log across restarts / baseline / kWh without SOH / use + otherKw / 48 V / 12 V / setting).');
    console.log('elDrive fully electric checks passed (iX3 found by itself / DDBC zeros / learning without an engine / slow charge / live power / settings / limits / reserve / hybrid on Auto).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
