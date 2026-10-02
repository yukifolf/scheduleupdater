
class filterSchedule {
    constructor(schedule, groupFilters = []) {
        this.schedule = schedule;
        this.groupFilters = groupFilters;
    }

    filterByGroup() {
        if (this.groupFilters.length === 0) {
            return this.schedule;
        }
        return this.schedule.filter(event => {
            return this.groupFilters.some(filter => event.group.includes(filter));
        });
    }
}

module.exports = filterSchedule;
