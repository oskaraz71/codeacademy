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

// autorizacija su validu
r.post("/register", validateRegister, ctrl.register);
r.post("/login", validateLogin, ctrl.login);

// postai---
r.get("/posts", ctrl.listPosts); // GET – be auth
r.post("/posts", requireAuth, validatePostCreate, ctrl.createPost);
r.put("/posts/:id", requireAuth, requireOwnership, validatePostUpdate, ctrl.updatePost);
r.delete("/posts/:id", requireAuth, requireOwnership, ctrl.deletePost);

//pridedam laikus---
r.post(
    "/posts/:id/like",
    requireAuth,
    (req, _res, next) => {
        console.log("[ROUTER] POST /posts/:id/like", {id: req.params.id, user: req.user?._id});
        next();
    },
    ctrl.likePost
);

r.delete(
    "/posts/:id/like",
    requireAuth,
    (req, _res, next) => {
        console.log("[ROUTER] DELETE /posts/:id/like", {id: req.params.id, user: req.user?._id});
        next();
    },
    ctrl.unlikePost
);

r.get(
    "/posts/:id/likes",
    (req, _res, next) => {
        console.log("[ROUTER] GET /posts/:id/likes", {id: req.params.id});
        next();
    },
    ctrl.getLikes
);

// Komentarai---
r.get(
    "/posts/:id/comments",
    (req, _res, next) => {
        console.log("[ROUTER] GET /posts/:id/comments", {id: req.params.id});
        next();
    },
    ctrl.getComments
);

r.post(
    "/posts/:id/comments",
    requireAuth,
    (req, _res, next) => {
        console.log("[ROUTER] POST /posts/:id/comments", {id: req.params.id, user: req.user?._id});
        next();
    },
    ctrl.addComment
);

module.exports = r;
