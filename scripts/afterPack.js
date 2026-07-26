const { execSync } = require("child_process");

/**
 * Removes extended attributes (Finder info, resource forks) from the packed
 * app on macOS. These get attached when the Electron archive is unpacked and
 * make codesign fail with "resource fork, Finder information, or similar
 * detritus not allowed".
 */
exports.default = async function (context) {
	if (context.electronPlatformName === "darwin") {
		execSync(`xattr -cr "${context.appOutDir}"`);
	}
};
