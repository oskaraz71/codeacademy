// NodeJs/modules/personGenerate.js
const { faker } = require("@faker-js/faker");

/**
 * Sugeneruoja vieną pilną vartotoją su visais UI laukais.
 */
function makeUser() {
    const sex = faker.person.sexType(); // 'male' | 'female'
    const first = faker.person.firstName(sex);
    const last = faker.person.lastName(sex);

    return {
        id: faker.string.uuid(),
        username: faker.internet.userName({ firstName: first, lastName: last }).toLowerCase(),
        name: `${first} ${last}`,
        jobTitle: faker.person.jobTitle(),

        email: faker.internet.email({ firstName: first, lastName: last }),
        phone: faker.phone.number(), // <- svarbu: 'phone'

        gender: sex,                 // <- 'male' / 'female'
        age: faker.number.int({ min: 18, max: 80 }),

        address: faker.location.streetAddress(),
        city: faker.location.city(),

        avatar: faker.image.avatar(), // ar faker.image.avatarGitHub()
    };
}

/**
 * @param {number} n
 * @returns {Array<object>}
 */
function generatePerson(n = 5) {
    return Array.from({ length: n }, makeUser);
}

module.exports = { generatePerson };
