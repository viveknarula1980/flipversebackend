const crypto = require("crypto");

// Uniform 1..100
function roll1to100() {
  return crypto.randomInt(1, 101);
}

module.exports = { roll1to100 };
