const GoogleCalendar = require('../calendar');

const sample = require('../test/fixtures/schedule.json');
const options = { timeMin: '2026-10-01', timeMax: '2027-02-22' };
const clone = value => JSON.parse(JSON.stringify(value));

function fakeCalendar(initial = [], { pageSize = 2, failInsert = false } = {}) {
    const calendar = new GoogleCalendar(options);
    const records = clone(initial);
    const calls = [];
    let nextId = 1;
    calendar.calendar = { events: {
        async list(params) {
            calls.push(['list', params]);
            const offset = Number(params.pageToken || 0);
            return { data: {
                items: clone(records.slice(offset, offset + pageSize)),
                nextPageToken: offset + pageSize < records.length ? String(offset + pageSize) : undefined,
            } };
        },
        async insert(params) {
            calls.push(['insert', params]);
            if (failInsert) throw new Error('Insert failed');
            const event = { ...clone(params.requestBody), id: `created-${nextId++}` };
            records.push(event);
            return { data: event };
        },
        async patch(params) {
            calls.push(['patch', params]);
            const index = records.findIndex(event => event.id === params.eventId);
            expect(index).not.toBe(-1);
            records[index] = { ...records[index], ...clone(params.requestBody) };
            return { data: records[index] };
        },
        async delete(params) {
            calls.push(['delete', params]);
            const index = records.findIndex(event => event.id === params.eventId);
            expect(index).not.toBe(-1);
            records.splice(index, 1);
            return { data: {} };
        },
    } };
    return { calendar, records, calls };
}

function managed(event, id) {
    return { ...new GoogleCalendar(options).toGoogleEvent(event), id };
}

test('creates all sample events, preserves every field, and is idempotent across pages', async () => {
    const { calendar, records, calls } = fakeCalendar([], { pageSize: 2 });
    const first = await calendar.syncEvents(sample);
    expect(first.create.length).toBe(sample.length);
    records.forEach((event, index) => {
        expect(event.description).toBe(calendar.formatDescription(sample[index]));
        expect(event.location).toBe(sample[index].room);
    });
    calls.length = 0;
    const second = await calendar.syncEvents(sample);
    expect(second.unchanged.length).toBe(sample.length);
    expect(second.create.length + second.update.length + second.delete.length).toBe(0);
    expect(calls.filter(([method]) => method === 'list').length > 1).toBe(true);
    expect(calls.every(([method]) => method === 'list')).toBe(true);
});

test('updates room, end time and metadata while retaining unrelated properties', async () => {
    const existing = managed(sample[0], 'original');
    existing.extendedProperties.private.otherApp = 'keep';
    existing.extendedProperties.shared = { sharedData: 'keep' };
    existing.attendees = [{ email: 'student@example.com' }];
    const { calendar, records } = fakeCalendar([existing]);
    const changed = { ...sample[0], room: 'Room 42', end: '2026-10-02T21:00:00',
        timeTo: '21:00', duration: 'new duration', examType: 'Exam', notes: 'Bring laptop' };
    const plan = await calendar.syncEvents([changed]);
    expect(plan.update.length).toBe(1);
    expect(plan.update[0].eventId).toBe('original');
    expect(plan.create.length + plan.delete.length).toBe(0);
    expect(records[0].description).toBe(calendar.formatDescription(changed));
    expect(records[0].extendedProperties.private.otherApp).toBe('keep');
    expect(records[0].extendedProperties.shared).toEqual({ sharedData: 'keep' });
    expect(records[0].attendees).toEqual(existing.attendees);
});

test('matches moved classes and renamed subjects without changing their Google IDs', async () => {
    for (const changes of [
        { start: '2026-10-02T18:00:00', end: '2026-10-02T21:00:00', timeFrom: '18:00', timeTo: '21:00' },
        { date: '2026-10-04', start: '2026-10-04T17:30:00', end: '2026-10-04T20:30:00' },
        { subject: 'Renamed subject' },
    ]) {
        const { calendar } = fakeCalendar([managed(sample[0], 'original')]);
        const plan = await calendar.syncEvents([{ ...sample[0], ...changes }], { dryRun: true });
        expect(plan.update.length).toBe(1);
        expect(plan.update[0].eventId).toBe('original');
        expect(plan.create.length + plan.delete.length).toBe(0);
    }
});

test('deletes absent managed events only, preserving personal, other-source and boundary events', async () => {
    const removed = managed(sample[0], 'removed');
    const personal = { ...managed(sample[1], 'personal'), extendedProperties: {} };
    const otherSource = managed(sample[2], 'other-source');
    otherSource.extendedProperties.private.scheduleSource = 'another-schedule';
    const crossing = managed({ ...sample[0], start: '2026-09-30T23:00:00', end: '2026-10-01T01:00:00' }, 'crossing');
    const afterRange = managed({ ...sample[0], start: '2027-02-22T00:00:00', end: '2027-02-22T01:00:00' }, 'after-range');
    const allDay = { id: 'all-day', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } };
    const { calendar, records } = fakeCalendar([removed, personal, otherSource, crossing, afterRange, allDay]);
    const plan = await calendar.syncEvents([]);
    expect(plan.delete.map(event => event.eventId)).toEqual(['removed']);
    expect(records.length).toBe(5);
});

test('adopts an exact existing event and compares equivalent UTC/offset times', async () => {
    const existing = managed(sample[0], 'manual');
    existing.start.dateTime = '2026-10-02T17:30:00+02:00';
    existing.end.dateTime = '2026-10-02T20:30:00+02:00';
    delete existing.extendedProperties;
    existing.description = 'Imported schedule';
    const { calendar } = fakeCalendar([existing]);
    const plan = await calendar.syncEvents([sample[0]], { dryRun: true });
    expect(plan.create.length).toBe(0);
    expect(plan.update[0].eventId).toBe('manual');
});

test('does not arbitrarily adopt a manual event shared by overlapping groups', async () => {
    const second = { ...sample[0], group: 'another-group' };
    const manual = managed(sample[0], 'manual');
    delete manual.extendedProperties;
    manual.description = '';
    const { calendar } = fakeCalendar([manual]);
    const plan = await calendar.syncEvents([sample[0], second], { dryRun: true });
    expect(plan.create.length).toBe(2);
    expect(plan.update.length + plan.delete.length).toBe(0);
});

test('dry run performs no writes and reports events outside the range', async () => {
    const { calendar, calls } = fakeCalendar([managed(sample[0], 'removed')]);
    const outside = { ...sample[0], start: '2027-03-01T17:30:00', end: '2027-03-01T20:30:00' };
    const plan = await calendar.syncEvents([sample[1], outside], { dryRun: true });
    expect(plan.create.length).toBe(1);
    expect(plan.delete.length).toBe(1);
    expect(plan.ignored).toBe(1);
    expect(calls.every(([method]) => method === 'list')).toBe(true);
});

test('rejects invalid input and duplicates before accessing the API', async () => {
    const { calendar, calls } = fakeCalendar();
    await expect(calendar.syncEvents([sample[0], sample[0]])).rejects.toThrow(/Duplicate/);
    await expect(calendar.syncEvents([{ ...sample[0], start: 'bad' }])).rejects.toThrow(/Invalid/);
    await expect(calendar.syncEvents([{ ...sample[0], end: sample[0].start }])).rejects.toThrow(/end must follow/);
    expect(calls.length).toBe(0);
    expect(() => new GoogleCalendar({ timeMin: '2026-10-02', timeMax: '2026-10-01' })).toThrow(/earlier/);
});

test('honors Warsaw daylight saving time independent of the machine timezone', () => {
    const calendar = new GoogleCalendar(options);
    expect(new Date(calendar.toTimestamp('2026-10-02T17:30:00')).toISOString()).toBe('2026-10-02T15:30:00.000Z');
    expect(new Date(calendar.toTimestamp('2026-11-02T17:30:00')).toISOString()).toBe('2026-11-02T16:30:00.000Z');
    expect(calendar.timeMin).toBe('2026-09-30T22:00:00.000Z');
    expect(() => calendar.toTimestamp('2026-03-29T02:30:00')).toThrow(/does not exist/);
});

test('does not delete anything when a create fails', async () => {
    const { calendar, records, calls } = fakeCalendar([managed(sample[0], 'removed')], { failInsert: true });
    await expect(calendar.syncEvents([sample[1]])).rejects.toThrow(/Insert failed/);
    expect(records.length).toBe(1);
    expect(calls.every(([method]) => method !== 'delete')).toBe(true);
});

describe('GoogleCalendar authentication and token persistence', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { EventEmitter } = require('events');

    let tempDir;
    let credsPath;
    let tokenPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-auth-test-'));
        credsPath = path.join(tempDir, 'credentials.json');
        tokenPath = path.join(tempDir, 'token.json');
        fs.writeFileSync(credsPath, JSON.stringify({
            installed: {
                client_id: 'test-client-id',
                client_secret: 'test-secret',
                redirect_uris: ['http://localhost'],
            },
        }));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    test('defaults tokenPath relative to credentialsPath', () => {
        const cal = new GoogleCalendar({ ...options, credentialsPath: credsPath });
        expect(cal.tokenPath).toBe(path.join(tempDir, 'token.json'));
    });

    test('loads saved tokens from disk without re-authenticating', async () => {
        const savedTokens = { access_token: 'valid-access', refresh_token: 'valid-refresh' };
        fs.writeFileSync(tokenPath, JSON.stringify(savedTokens));

        const cal = new GoogleCalendar({ ...options, credentialsPath: credsPath, tokenPath });
        await cal.init();

        expect(cal.auth).toBeDefined();
        expect(cal.auth.credentials).toEqual(expect.objectContaining(savedTokens));
        expect(cal.calendar).toBeDefined();
    });

    test('authenticates and saves tokens to disk when token file is absent', async () => {
        const localAuth = require('@google-cloud/local-auth');
        const mockAuth = new EventEmitter();
        mockAuth.credentials = { access_token: 'new-access', refresh_token: 'new-refresh' };
        const authSpy = jest.spyOn(localAuth, 'authenticate').mockResolvedValue(mockAuth);

        const cal = new GoogleCalendar({ ...options, credentialsPath: credsPath, tokenPath });
        await cal.init();

        expect(authSpy).toHaveBeenCalledWith({
            keyfilePath: credsPath,
            scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        expect(fs.existsSync(tokenPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(tokenPath, 'utf8'))).toEqual(mockAuth.credentials);

        mockAuth.emit('tokens', { access_token: 'refreshed-access' });
        const updated = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        expect(updated.access_token).toBe('refreshed-access');
        expect(updated.refresh_token).toBe('new-refresh');
    });

    test('formats description matching the human-readable template', () => {
        const cal = new GoogleCalendar(options);
        const event = {
            plan: 'Plan dla toku: IS/WSEI N mgr inż. 1.5 2025/2026 lato',
            date: '2026-10-03',
            timeFrom: '16:20',
            timeTo: '17:50',
            duration: '2h00m',
            subject: 'Język obcy dla informatyków',
            form: '1',
            group: 'Cw',
            room: 'F Zajęcia zdalne na Teams',
            teacher: 'mgr Katarzyna Szumińska',
            examType: 'Egzamin',
            notes: '',
        };
        const desc = cal.formatDescription(event);
        expect(desc).toBe([
            'Plan dla toku: IS/WSEI N mgr inż. 1.5 2025/2026 lato',
            '',
            ' Data zajęć: 2026.10.03 sobota',
            ' Czas od: 16:20',
            ' Czas do: 17:50',
            ' Liczba godzin: 2h00m',
            ' Przedmiot: Język obcy dla informatyków',
            ' Forma zajęć: 1',
            ' Grupy: Cw',
            ' Sala: F Zajęcia zdalne na Teams',
            ' Prowadzący: mgr Katarzyna Szumińska',
            ' Forma zaliczenia: Egzamin',
            ' Uwagi: ',
        ].join('\n'));
    });
});
