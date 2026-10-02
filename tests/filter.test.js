const FilterSchedule = require('../filter');

describe('filterByGroup', () => {
    let schedule;

    beforeEach(() => {
        schedule = [
            { subject: 'First', group: 'konw/2/IS-CP IIsemN' },
            { subject: 'Second', group: 'konw/2/IS-AI IIsemN' },
            { subject: 'Third', group: 'lab1/2/IS-CP IIsemN, lab2/2/IS-CP IIsemN' },
            { subject: 'Fourth', group: '' },
        ];
    });

    test('returns the original schedule when filters are omitted or empty', () => {
        expect(new FilterSchedule(schedule).filterByGroup()).toBe(schedule);
        expect(new FilterSchedule(schedule, []).filterByGroup()).toBe(schedule);
    });

    test('matches substrings in simple and combined group fields', () => {
        expect(new FilterSchedule(schedule, ['IS-CP']).filterByGroup())
            .toEqual([schedule[0], schedule[2]]);
        expect(new FilterSchedule(schedule, ['lab2/2']).filterByGroup()).toEqual([schedule[2]]);
    });

    test('includes events matching any filter and preserves their order', () => {
        expect(new FilterSchedule(schedule, ['lab2/2', 'IS-AI']).filterByGroup())
            .toEqual([schedule[1], schedule[2]]);
    });

    test('includes an event only once when multiple filters match it', () => {
        expect(new FilterSchedule(schedule, ['IS-CP', 'lab1/2', 'IS-CP']).filterByGroup())
            .toEqual([schedule[0], schedule[2]]);
    });

    test('returns an empty array when nothing matches or the schedule is empty', () => {
        expect(new FilterSchedule(schedule, ['unknown-group']).filterByGroup()).toEqual([]);
        expect(new FilterSchedule([], ['IS-CP']).filterByGroup()).toEqual([]);
    });

    test('group matching is case sensitive', () => {
        expect(new FilterSchedule(schedule, ['is-cp']).filterByGroup()).toEqual([]);
    });

    test('does not mutate the input schedule or its events', () => {
        const original = JSON.parse(JSON.stringify(schedule));
        const result = new FilterSchedule(schedule, ['IS-AI']).filterByGroup();
        expect(schedule).toEqual(original);
        expect(result).not.toBe(schedule);
        expect(result[0]).toBe(schedule[1]);
    });
});
