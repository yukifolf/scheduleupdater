const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');
const CSVParser = require('../parser');

describe('CSVParser', () => {
    let directory;
    let filename;
    let parser;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-parser-'));
        filename = path.join(directory, 'schedule.csv');
        parser = new CSVParser(filename);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        // Only remove this test's known file and empty directory, without recursive deletion.
        if (fs.existsSync(filename)) fs.unlinkSync(filename);
        fs.rmdirSync(directory);
    });

    function writeCsv(lines, newline = '\n') {
        fs.writeFileSync(filename, iconv.encode(lines.join(newline), 'win1250'));
    }

    test.each(['\n', '\r\n'])('parses every field with newline %j and Windows-1250 Polish text', newline => {
        writeCsv([
            'Data Zajec: 2026.10.03 sobota',
            ';8:05;9:30;2h00m;lab1/2/IS-CP IIsemN;  Inżynieria bezpieczeństwa  ;  Sala Łódź  ;  Zaliczenie z oceną  ;  Przynieś książkę  ;',
        ], newline);
        const events = parser.parse();
        expect(events).toEqual([{
            date: '2026-10-03',
            start: '2026-10-03T08:05:00',
            end: '2026-10-03T09:30:00',
            timeFrom: '8:05', timeTo: '9:30', duration: '2h00m',
            group: 'lab1/2/IS-CP IIsemN', subject: 'Inżynieria bezpieczeństwa',
            room: 'Sala Łódź', examType: 'Zaliczenie z oceną', notes: 'Przynieś książkę',
        }]);
        expect(parser.data).toBe(events);
    });

    test('uses each date header for the following rows', () => {
        writeCsv([
            'Data Zajec: 2026.10.03 sobota', ';8:00;9:00;1h;group;First;;;',
            'Data Zajec: 2026.10.04 niedziela', ';10:00;11:00;1h;group;Second;;;',
        ]);
        expect(parser.parse().map(event => [event.date, event.subject])).toEqual([
            ['2026-10-03', 'First'], ['2026-10-04', 'Second'],
        ]);
    });

    test('skips blank lines, headers, rows before a date, and rows missing either time', () => {
        writeCsv([
            ';8:00;9:00;1h;group;Before date', 'Data Zajec: unknown',
            ';8:00;9:00;1h;group;Still before date',
            'Data Zajec: 2026.10.03 sobota', '', '   ', 'Od;Do;Przedmiot',
            ';;9:00;1h;group;Missing start', ';8:00;;1h;group;Missing end',
            ';8:00;9:00;1h;group;Valid',
        ]);
        expect(parser.parse().map(event => event.subject)).toEqual(['Valid']);
    });

    test('defaults omitted optional fields to empty strings', () => {
        writeCsv(['Data Zajec: 2026.10.03 sobota', ';8:00;9:00']);
        expect(parser.parse()[0]).toMatchObject({
            duration: '', group: '', subject: '', room: '', examType: '', notes: '',
        });
    });

    test('replaces previous results on each parse instead of accumulating events', () => {
        writeCsv(['Data Zajec: 2026.10.03 sobota', ';8:00;9:00;1h;group;First']);
        expect(parser.parse()).toHaveLength(1);
        expect(parser.parse()).toHaveLength(1);
        writeCsv(['Data Zajec: 2026.10.04 niedziela', ';10:00;11:00;1h;group;Replacement']);
        expect(parser.parse().map(event => event.subject)).toEqual(['Replacement']);
        expect(parser.data[0].date).toBe('2026-10-04');
    });

    test('returns an empty array for a file without valid events', () => {
        writeCsv(['Heading', '', 'Data Zajec: 2026.10.03 sobota']);
        expect(parser.parse()).toEqual([]);
        expect(parser.data).toEqual([]);
    });

    test('propagates file read errors', () => {
        expect(() => parser.parse()).toThrow(/ENOENT/);
    });

    test.each([
        ['8:5', '08:05'], ['8:00', '08:00'], ['17:30', '17:30'],
    ])('normalizes %s to %s', (input, expected) => {
        expect(parser.normalizeTime(input)).toBe(expected);
    });

    test.each([
        { label: 'empty array', data: [] },
        { label: 'missing data', data: null },
    ])('rejects $label', ({ data }) => {
        parser.data = data;
        expect(() => parser.checkJsonisEmpty()).toThrow(`Parsed data is empty: ${filename}`);
    });

    test('accepts nonempty parsed data', () => {
        writeCsv(['Data Zajec: 2026.10.03 sobota', ';8:00;9:00;1h;group;Subject']);
        parser.parse();
        expect(() => parser.checkJsonisEmpty()).not.toThrow();
    });

    test('removes its parsed CSV file', () => {
        writeCsv(['Sample CSV']);
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        parser.removeParsedFile();
        expect(fs.existsSync(filename)).toBe(false);
        expect(log).toHaveBeenCalledWith(`Removed parsed file: ${filename}`);
    });

    test('does nothing when the parsed file is already missing', () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => parser.removeParsedFile()).not.toThrow();
        expect(log).not.toHaveBeenCalled();
    });
});
