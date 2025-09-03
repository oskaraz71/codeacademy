// routers/blogRouter.js
const express = require("express");
const ctrl = require("../controllers/blogController");
const {
    requireAuth,
    validateRegister,
    validateLogin,
    validatePostCreate,
    validatePostUpdate,
    requireOwnership,
} = require("../middleware/authValidators");

const r = express.Router();

r.get("/health", ctrl.health);

// auth
r.post("/register", validateRegister, ctrl.register);
r.post("/login", validateLogin, ctrl.login);

// posts
r.get("/posts", ctrl.listPosts);
r.post("/posts", requireAuth, validatePostCreate, ctrl.createPost);
r.put("/posts/:id", requireAuth, requireOwnership, validatePostUpdate, ctrl.updatePost);
r.delete("/posts/:id", requireAuth, requireOwnership, ctrl.deletePost);

// likes
r.post("/posts/:id/like", requireAuth, ctrl.likePost);
r.delete("/posts/:id/like", requireAuth, ctrl.unlikePost);
r.get("/posts/:id/likes", ctrl.getLikes);

// comments
r.get("/posts/:id/comments", ctrl.getComments);
r.post("/posts/:id/comments", requireAuth, ctrl.addComment);

// ---- users ----
r.get("/users", ctrl.listUsers);                        // list
r.post("/users/:id/poke", requireAuth, ctrl.pokeUser);  // one-time poke (not self)
r.get("/users/:id/pokes", ctrl.getUserPokes);           // who poked this user
r.put("/users/me", requireAuth, ctrl.updateMe);         // update my profile

module.exports = r;
