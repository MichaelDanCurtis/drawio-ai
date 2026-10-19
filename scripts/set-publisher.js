// Sets the Marketplace publisher id in package.json (the only place it is used).
// Usage: node scripts/set-publisher.js <publisher-id>
const fs = require("fs");
const path = require("path");

const id = process.argv[2];
if (!id || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
	console.error("Usage: node scripts/set-publisher.js <publisher-id>   (letters, digits and dashes, as shown on https://marketplace.visualstudio.com/manage)");
	process.exit(1);
}
const file = path.resolve(__dirname, "../package.json");
const text = fs.readFileSync(file, "utf8");
const updated = text.replace(/("publisher":\s*")[^"]*(")/, `$1${id}$2`);
if (updated === text && !text.includes(`"publisher": "${id}"`)) {
	console.error('Could not find "publisher" in package.json.');
	process.exit(1);
}
fs.writeFileSync(file, updated);
console.log(`publisher set to "${id}". The extension id is now ${id}.${JSON.parse(updated).name}.`);
