const fs = require('fs');
const ScheduleDownloader = require('../download');

const options = {
    sessionId: 'test-session',
    id: 1088,
    dateFrom: '10/01/2026 00:00:00',
    dateTo: '02/21/2027 00:00:00',
    outputPath: './tmp/test-schedule.csv',
    origUrl: 'https://schedule.example/Plany/WydrukTokuCsv/',
};

describe('ScheduleDownloader', () => {
    let downloader;
    let fetchMock;
    let writeFile;
    let exists;
    let stat;
    let warn;

    // Include non-ASCII bytes to ensure the downloaded CSV is saved unchanged.
    const bytes = Uint8Array.from([59, 56, 58, 48, 48, 59, 163, 243, 100, 159, 13, 10]);

    function successfulResponse() {
        return {
            ok: true,
            status: 200,
            arrayBuffer: jest.fn().mockResolvedValue(bytes.buffer),
            text: jest.fn(),
        };
    }

    function failedResponse(status, body) {
        return {
            ok: false,
            status,
            text: jest.fn().mockResolvedValue(body),
            arrayBuffer: jest.fn(),
        };
    }

    beforeEach(() => {
        downloader = new ScheduleDownloader(options);
        fetchMock = jest.spyOn(globalThis, 'fetch');
        writeFile = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        stat = jest.spyOn(fs, 'statSync').mockReturnValue({ size: bytes.length });
        jest.spyOn(console, 'log').mockImplementation(() => {});
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('requests the configured schedule and saves the exact binary response', async () => {
        const response = successfulResponse();
        fetchMock.mockResolvedValue(response);

        await expect(downloader.downloadSchedule()).resolves.toBe(options.outputPath);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, request] = fetchMock.mock.calls[0];
        const parsedUrl = new URL(url);
        expect(parsedUrl.origin).toBe('https://schedule.example');
        expect(parsedUrl.pathname).toBe('/Plany/WydrukTokuCsv/1088');
        expect(parsedUrl.searchParams.get('dO')).toBe(options.dateFrom);
        expect(parsedUrl.searchParams.get('dD')).toBe(options.dateTo);
        expect(request).toEqual({
            method: 'GET',
            headers: {
                Cookie: 'ASP.NET_SessionId=test-session; .culture=c=pl|uic=pl; RadioList_TerminT=2026,10,1%5C2027,2,21%5C3',
                Referer: 'https://schedule.example/Plany/WydrukTokuCsv/1088',
                'User-Agent': 'Mozilla/5.0',
                Accept: '*/*',
            },
        });
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledWith(options.outputPath, Buffer.from(bytes));
        expect(response.arrayBuffer).toHaveBeenCalledTimes(1);
        expect(response.text).not.toHaveBeenCalled();
    });

    test('uses the default output path when none is supplied', async () => {
        const { outputPath, ...withoutOutputPath } = options;
        const defaultDownloader = new ScheduleDownloader(withoutOutputPath);
        fetchMock.mockResolvedValue(successfulResponse());

        await expect(defaultDownloader.downloadSchedule()).resolves.toBe('./tmp/harmonogram.csv');
        expect(writeFile).toHaveBeenCalledWith('./tmp/harmonogram.csv', Buffer.from(bytes));
    });

    test.each([401, 403, 404, 500])('rejects HTTP %i with its response body and does not write a file', async status => {
        const response = failedResponse(status, 'Server rejected the request');
        fetchMock.mockResolvedValue(response);

        await expect(downloader.downloadSchedule())
            .rejects.toThrow(`Request failed (HTTP ${status}): Server rejected the request`);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(response.text).toHaveBeenCalledTimes(1);
        expect(response.arrayBuffer).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('waits 60 seconds before retrying HTTP 429 and then saves the successful response', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValueOnce(failedResponse(429, 'Too many requests'))
            .mockResolvedValueOnce(successfulResponse());
        const result = downloader.downloadSchedule();

        await jest.advanceTimersByTimeAsync(59999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(writeFile).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('Received 429 Too Many Requests. Retrying after 60 seconds...');

        await jest.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe(options.outputPath);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(writeFile).toHaveBeenCalledWith(options.outputPath, Buffer.from(bytes));
    });

    test('tracks retry count across rate-limit retries and resets it after a successful download', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValueOnce(failedResponse(429, 'First rejection'))
            .mockResolvedValueOnce(failedResponse(429, 'Second rejection'))
            .mockResolvedValueOnce(successfulResponse());

        const result = downloader.downloadSchedule();

        await jest.advanceTimersByTimeAsync(60000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(downloader.retryCount).toBe(2);
        expect(writeFile).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(60000);
        await expect(result).resolves.toBe(options.outputPath);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(downloader.retryCount).toBe(0);
        expect(writeFile).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    test('retries repeated HTTP 429 responses without writing their bodies', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValueOnce(failedResponse(429, 'First rejection'))
            .mockResolvedValueOnce(failedResponse(429, 'Second rejection'))
            .mockResolvedValueOnce(successfulResponse());
        const result = downloader.downloadSchedule();

        await jest.advanceTimersByTimeAsync(60000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(writeFile).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(60000);

        await expect(result).resolves.toBe(options.outputPath);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(writeFile).toHaveBeenCalledTimes(1);
    });

    test('propagates an HTTP failure returned after a rate-limit retry', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValueOnce(failedResponse(429, 'Too many requests'))
            .mockResolvedValueOnce(failedResponse(500, 'Server error'));
        const rejection = expect(downloader.downloadSchedule())
            .rejects.toThrow('Request failed (HTTP 500): Server error');

        await jest.advanceTimersByTimeAsync(60000);
        await rejection;
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('throws once the retry limit is exceeded', async () => {
        jest.useFakeTimers();
        fetchMock.mockResolvedValue(failedResponse(429, 'Too many requests'));

        const rejection = expect(downloader.downloadSchedule())
            .rejects.toThrow('Exceeded retry limit of 5.');

        await jest.advanceTimersByTimeAsync(60000 * 5);
        await rejection;

        expect(fetchMock).toHaveBeenCalledTimes(5);
        expect(downloader.retryCount).toBe(5);
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('propagates network errors without writing a file', async () => {
        const error = new Error('Network unavailable');
        fetchMock.mockRejectedValue(error);

        await expect(downloader.downloadSchedule()).rejects.toBe(error);
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('propagates response read errors without writing a file', async () => {
        const error = new Error('Response stream interrupted');
        const response = successfulResponse();
        response.arrayBuffer.mockRejectedValue(error);
        fetchMock.mockResolvedValue(response);

        await expect(downloader.downloadSchedule()).rejects.toBe(error);
        expect(writeFile).not.toHaveBeenCalled();
    });

    test('propagates filesystem write errors', async () => {
        const error = new Error('Disk full');
        fetchMock.mockResolvedValue(successfulResponse());
        writeFile.mockImplementation(() => { throw error; });

        await expect(downloader.downloadSchedule()).rejects.toBe(error);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('accepts an existing nonempty file', () => {
        expect(() => downloader.checkFileSize()).not.toThrow();
        expect(exists).toHaveBeenCalledWith(options.outputPath);
        expect(stat).toHaveBeenCalledWith(options.outputPath);
    });

    test('rejects a missing file without checking its size', () => {
        exists.mockReturnValue(false);

        expect(() => downloader.checkFileSize()).toThrow(`File not found: ${options.outputPath}`);
        expect(stat).not.toHaveBeenCalled();
    });

    test('rejects an empty file', () => {
        stat.mockReturnValue({ size: 0 });

        expect(() => downloader.checkFileSize()).toThrow(`File is empty: ${options.outputPath}`);
    });

    test('propagates filesystem stat errors', () => {
        const error = new Error('Cannot read file metadata');
        stat.mockImplementation(() => { throw error; });

        expect(() => downloader.checkFileSize()).toThrow(error);
    });

    describe('automatic session management', () => {
        function viewResponse(cookie = 'ASP.NET_SessionId=auto-session-123; path=/; HttpOnly') {
            return {
                ok: true,
                status: 200,
                headers: {
                    getSetCookie: () => [cookie],
                    get: () => cookie,
                },
            };
        }

        test('automatically fetches session from derived viewUrl when sessionId is not provided', async () => {
            const { sessionId, ...withoutSession } = options;
            const autoDownloader = new ScheduleDownloader(withoutSession);

            fetchMock
                .mockResolvedValueOnce(viewResponse('ASP.NET_SessionId=derived-session-456; path=/'))
                .mockResolvedValueOnce(successfulResponse());

            await expect(autoDownloader.downloadSchedule()).resolves.toBe(options.outputPath);

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0][0]).toBe('https://schedule.example/Plany/PlanyTokow/1088');
            expect(fetchMock.mock.calls[0][1].headers.Cookie).toContain('RadioList_TerminT=2026,10,1%5C2027,2,21%5C3');
            expect(fetchMock.mock.calls[0][1].headers.Cookie).toContain('.culture=c=pl|uic=pl');
            expect(fetchMock.mock.calls[1][1].headers.Cookie).toContain('ASP.NET_SessionId=derived-session-456');
        });

        test('uses configured viewUrl when provided', async () => {
            const { sessionId, ...withoutSession } = options;
            const autoDownloader = new ScheduleDownloader({
                ...withoutSession,
                viewUrl: 'https://custom.example/Plany/PlanyTokow/',
            });

            fetchMock
                .mockResolvedValueOnce(viewResponse('ASP.NET_SessionId=custom-view-session'))
                .mockResolvedValueOnce(successfulResponse());

            await expect(autoDownloader.downloadSchedule()).resolves.toBe(options.outputPath);

            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[0][0]).toBe('https://custom.example/Plany/PlanyTokow/1088');
            expect(fetchMock.mock.calls[1][1].headers.Cookie).toContain('ASP.NET_SessionId=custom-view-session');
        });

        test('rejects when viewUrl request returns an HTTP error', async () => {
            const { sessionId, ...withoutSession } = options;
            const autoDownloader = new ScheduleDownloader(withoutSession);

            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 500,
            });

            await expect(autoDownloader.downloadSchedule())
                .rejects.toThrow('Failed to obtain session from https://schedule.example/Plany/PlanyTokow/1088 (HTTP 500)');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test('rejects when ASP.NET_SessionId cookie is missing from viewUrl response', async () => {
            const { sessionId, ...withoutSession } = options;
            const autoDownloader = new ScheduleDownloader(withoutSession);

            fetchMock.mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: {
                    getSetCookie: () => [],
                    get: () => null,
                },
            });

            await expect(autoDownloader.downloadSchedule())
                .rejects.toThrow('ASP.NET_SessionId cookie not found in response from https://schedule.example/Plany/PlanyTokow/1088');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        test('automatically fetches fresh session and retries if provided sessionId returns expired schedule', async () => {
            const expiredScheduleBytes = Buffer.from(
                'Plan dla toku: IS/WSEI N\nCzas od;Czas do;Liczba godzin;\n'
            );
            const expiredResponse = {
                ok: true,
                status: 200,
                arrayBuffer: jest.fn().mockResolvedValue(expiredScheduleBytes.buffer),
                text: jest.fn(),
            };

            fetchMock
                .mockResolvedValueOnce(expiredResponse)
                .mockResolvedValueOnce(viewResponse('ASP.NET_SessionId=refreshed-session'))
                .mockResolvedValueOnce(successfulResponse());

            await expect(downloader.downloadSchedule()).resolves.toBe(options.outputPath);

            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(fetchMock.mock.calls[0][1].headers.Cookie).toContain('ASP.NET_SessionId=test-session');
            expect(fetchMock.mock.calls[1][0]).toBe('https://schedule.example/Plany/PlanyTokow/1088');
            expect(fetchMock.mock.calls[2][1].headers.Cookie).toContain('ASP.NET_SessionId=refreshed-session');
        });
    });
});
