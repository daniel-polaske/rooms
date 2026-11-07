/**
 * Architecture rules. The README's layout table, made executable.
 *
 *   index.ts   Router: the only module that may import the objects and the Workflow.
 *   room.ts    RoomDO        }  talk to each other only through bindings (env.*),
 *   directory.ts DirectoryDO }  never by import: the object boundary is the
 *   archive.ts ArchiveWorkflow } only coupling, and it has to stay that way to shard.
 *   access.ts  pure verification; depends on nothing in src.
 *   log.ts     the leaf; depends on nothing.
 *
 * `npm run depcruise` fails on any violation. Add a rule when you add a layer.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "A cycle in the module graph is a cycle in your head.",
      from: {},
      to: { circular: true },
    },
    {
      name: "objects-do-not-import-each-other",
      severity: "error",
      comment: "RoomDO, DirectoryDO and ArchiveWorkflow talk through env bindings only.",
      from: { path: "^src/(room|directory|archive)\\.ts$" },
      to: { path: "^src/(room|directory|archive)\\.ts$" },
    },
    {
      name: "only-the-router-imports-objects",
      severity: "error",
      comment: "Only index.ts may import the object and Workflow classes (to re-export them).",
      from: { path: "^src/", pathNot: "^src/index\\.ts$" },
      to: { path: "^src/(room|directory|archive)\\.ts$", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "nothing-imports-the-router",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^src/index\\.ts$" },
    },
    {
      name: "leaves-stay-leaves",
      severity: "error",
      comment: "log.ts and access.ts depend on nothing else in src.",
      from: { path: "^src/(log|access)\\.ts$" },
      to: { path: "^src/" },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment: "A module nothing imports is dead or forgotten.",
      from: { orphan: true, pathNot: "\\.d\\.ts$" },
      to: {},
    },
    {
      name: "no-node-builtins-in-the-worker",
      severity: "error",
      comment: "The Worker speaks web-standard APIs only (it could run on workerd, celld or Cloudflare unchanged).",
      from: { path: "^src/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "no-deprecated-deps",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["deprecated"] },
    },
    {
      name: "no-dev-deps-in-src",
      severity: "error",
      comment: "Anything src imports has to be shipped.",
      from: { path: "^src/" },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default", "types"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
