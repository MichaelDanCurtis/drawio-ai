const passport = require("passport");

exports.requireAuth = passport.authenticate("bearer", { session: false });
