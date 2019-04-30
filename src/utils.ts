export function maxProperty(array: any[], property: string): number {
	let max = array[0][property];
	for (const item of array) {
		if (item[property] > max) {
			max = item[property];
		} else {

		}
	}

	return max;
}

export function minProperty(array: any[], property: string): number {
	let min = array[0][property];
	for (const item of array) {
		if (item[property] < min) {
			min = item[property];
		}
	}

	return min;
}
