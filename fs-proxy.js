const fs = {};

console.error('fs.existsSync is not supported in the browser');

// Patch existsSync if it's missing
const patchedFs = {
   ...fs,
   existsSync: () => false
};

// Add the default export if necessary
patchedFs.default = patchedFs;

module.exports = patchedFs;
