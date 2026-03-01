# Yet another multi repository manager

Why it is exists?

I've tried to work with a multi repo, with rush.js, with turbo and pnpm, it become horror to manage all dependencies and versions. So I decided to create my own tool to simplity and speednup my daily workflow.

A plan:

1. yama build (done) -> perform a build of all sources in multi-repo, necessary to do bundle -> docker build.
2. yama validate (done) -> perform generation for all typings and typescript validation, in one process. 
3. yama bundle/docker:build -> a custom command executed per defined package.json files, with dependency to build/validate.
3. yama watch -> (build + validate + bundle + docker:build) all in one process, do a proper watch and update changed pcakges only.


## Tools:

1. Yama dependecy search tools.
2. Yama find unused deps.

TODOS:
* Plan to use tree-sitter/go tree sitter, to perform code changes modifications and search.
