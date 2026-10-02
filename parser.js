const fs = require('fs');
const iconv = require('iconv-lite');

class CSVParser {
    constructor(filename = './tmp/Plany.Csv') {
        this.data = [];
        this.path = filename;
    }

    parse() {
        const content = iconv.decode(fs.readFileSync(this.path), 'win1250');
        const lines = content
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(Boolean);

        const events = [];
        let currentDate = null;

        for (const line of lines) {
            if (line.startsWith('Data Zajec:')) {
                const match = line.match(/Data Zajec:\s*(\d{4}\.\d{2}\.\d{2})/);

                if (match) {
                    currentDate = match[1].replace(/\./g, '-');
                }

                continue;
            }

            if (!line.startsWith(';') || !currentDate) {
                continue;
            }

            const [
                ignored,
                timeFrom,
                timeTo,
                duration,
                group,
                subject,
                room,
                examType,
                notes
            ] = line.split(';');

            if (!timeFrom || !timeTo) {
                continue;
            }

            events.push({
                date: currentDate,
                start: `${currentDate}T${this.normalizeTime(timeFrom)}:00`,
                end: `${currentDate}T${this.normalizeTime(timeTo)}:00`,
                timeFrom,
                timeTo,
                duration: duration || '',
                group: group || '',
                subject: subject?.trim() || '',
                room: room?.trim() || '',
                examType: examType?.trim() || '',
                notes: notes?.trim() || ''
            });
        }

        this.data = events;
        return events;
    }

    normalizeTime(time) {
        const [hour, minute] = time.split(':');
        return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    }

    checkJsonisEmpty() {
        if (!this.data || this.data.length === 0) {
            throw new Error(`Parsed data is empty: ${this.path}`);
        }
    }

    removeParsedFile() {
        if (fs.existsSync(this.path)) {
            fs.unlinkSync(this.path);
            console.log(`Removed parsed file: ${this.path}`);
        }
    }   
}

module.exports = CSVParser;

if (require.main === module) {
    const parser = new CSVParser(process.argv[2] || './tmp/Plany.Csv');
    const events = parser.parse();

    console.log(JSON.stringify(events, null, 2));
    fs.writeFileSync('./tmp/schedule.json', JSON.stringify(events, null, 2), 'utf8');

    console.log(`Parsed ${events.length} events.`);
    console.log('Saved to schedule.json');
}
