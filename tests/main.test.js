const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const { ScheduleUpdater, INTERVAL_MS } = require('../main');

describe('schedule update loop', () => {
    let directory;
    let updater;
    let fetchMock;
    let records;
    let api;
    let options;

    const csv = [
        'Data Zajec: 2026.10.03 sobota',
        ';8:00;9:00;1h;IS-CP;First;Room 1;;',
        ';10:00;11:00;1h;IS-AI;Second;Room 2;;',
    ].join('\n');

    function response(content = csv) {
        return {
            ok: true, status: 200,
            arrayBuffer: async () => Uint8Array.from(iconv.encode(content, 'win1250')).buffer,
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-loop-'));
        options = {
            scheduleID: '1088', sessionId: 'test-session',
            dateFrom: '10/01/2026 00:00:00', dateTo: '02/21/2027 00:00:00',
            url: 'https://schedule.example/',
            outputPath: path.join(directory, 'download', 'schedule.csv'),
            calendarId: 'test-calendar', groupFilters: ['IS-CP'],
        };
        updater = new ScheduleUpdater(options);
        fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response());
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        records = [];
        api = {
            list: jest.fn(async () => ({ data: { items: [...records] } })),
            insert: jest.fn(async ({ requestBody }) => {
                const event = { ...requestBody, id: `event-${records.length + 1}` };
                records.push(event);
                return { data: event };
            }),
            patch: jest.fn(async ({ eventId, requestBody }) => {
                Object.assign(records.find(record => record.id === eventId), requestBody);
                return { data: {} };
            }),
            delete: jest.fn(async ({ eventId }) => {
                records.splice(records.findIndex(record => record.id === eventId), 1);
                return { data: {} };
            }),
        };
        jest.spyOn(updater.calendar, 'init').mockImplementation(async () => {
            updater.calendar.calendar = { events: api };
            return updater.calendar;
        });
    });

    afterEach(() => {
        updater.stop();
        jest.useRealTimers();
        jest.restoreAllMocks();
        if (fs.existsSync(options.outputPath)) fs.unlinkSync(options.outputPath);
        const downloadDirectory = path.dirname(options.outputPath);
        if (fs.existsSync(downloadDirectory)) fs.rmdirSync(downloadDirectory);
        fs.rmdirSync(directory);
    });

    test('downloads, checks, parses, filters, matches and updates without duplicates', async () => {
        const first = await updater.runOnce();
        expect(first.create).toHaveLength(1);
        expect(records[0].summary).toBe('First');
        expect(JSON.parse(records[0].description).group).toBe('IS-CP');
        expect(fs.existsSync(options.outputPath)).toBe(true);

        const second = await updater.runOnce();
        expect(second.unchanged).toHaveLength(1);
        expect(api.insert).toHaveBeenCalledTimes(1);
        expect(updater.calendar.init).toHaveBeenCalledTimes(1);

        fetchMock.mockResolvedValue(response(csv.replace('Room 1', 'Room 42')));
        const third = await updater.runOnce();
        expect(third.update[0].eventId).toBe('event-1');
        expect(records[0].location).toBe('Room 42');
        expect(api.patch).toHaveBeenCalledTimes(1);
    });

    test('starts immediately, repeats every 15 minutes, and stops scheduling', async () => {
        updater.start();
        updater.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(INTERVAL_MS - 1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        updater.stop();
        await jest.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('skips overlapping updates and resumes on the next interval', async () => {
        let finishDownload;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishDownload = resolve; }));
        updater.start();
        await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(api.list).not.toHaveBeenCalled();
        finishDownload(response());
        await jest.advanceTimersByTimeAsync(0);
        expect(api.insert).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('logs failed cycles and recovers on the next interval with a fresh retry budget', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
        updater.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('next 15-minute interval'),
            expect.objectContaining({ message: 'Network unavailable' }));
        expect(api.list).not.toHaveBeenCalled();
        updater.downloader.retryCount = 5;
        await jest.advanceTimersByTimeAsync(INTERVAL_MS);
        expect(updater.downloader.retryCount).toBe(0);
        expect(api.insert).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['', /File is empty/],
        ['An HTML login page instead of CSV', /Parsed data is empty/],
    ])('rejects unusable download %j before accessing the calendar', async (content, error) => {
        fetchMock.mockResolvedValue(response(content));
        await expect(updater.runOnce()).rejects.toThrow(error);
        expect(updater.calendar.init).not.toHaveBeenCalled();
        expect(api.list).not.toHaveBeenCalled();
        expect(updater.running).toBe(false);
    });

    test('retries authentication after failure and releases the loop after API failure', async () => {
        updater.calendar.init.mockRejectedValueOnce(new Error('Authentication failed'));
        await expect(updater.runOnce()).rejects.toThrow('Authentication failed');
        expect(updater.initialized).toBe(false);
        api.list.mockRejectedValueOnce(new Error('Calendar unavailable'));
        await expect(updater.runOnce()).rejects.toThrow('Calendar unavailable');
        expect(updater.running).toBe(false);
        await expect(updater.runOnce()).resolves.toMatchObject({ create: [expect.any(Object)] });
        expect(updater.calendar.init).toHaveBeenCalledTimes(2);
    });

    test('removes managed events when valid data no longer contains the selected group', async () => {
        await updater.runOnce();
        fetchMock.mockResolvedValue(response(csv.replace('IS-CP', 'IS-OTHER')));
        const plan = await updater.runOnce();
        expect(plan.delete).toHaveLength(1);
        expect(records).toHaveLength(0);
    });

    test('defaults to all groups and includes the full final day in Warsaw time', async () => {
        updater.groupFilters = [];
        await updater.runOnce();
        expect(records).toHaveLength(2);
        expect(updater.calendar.timeMin).toBe('2026-09-30T22:00:00.000Z');
        expect(updater.calendar.timeMax).toBe('2027-02-21T23:00:00.000Z');
        expect(() => new ScheduleUpdater({ ...options, dateFrom: '02/30/2026 00:00:00' }))
            .toThrow(/Invalid schedule date/);
        expect(() => new ScheduleUpdater({ ...options, groupFilters: 'IS-CP' }))
            .toThrow(/groupFilters/);
    });
});
