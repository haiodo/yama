# Yet another multi repository manager

Why it is exists?

I've tried to work with a multi repo, with rush.js, with turbo and pnpm, it become horror to manage all dependencies and versions. So I decided to create my own tool.

1. Get rid of package.json at all, it will be automatically generated in a .build folder and your sources will be free from all burden.
2. A small and robust package definition file is a must, so it will be.
3. Cons, some of existing IDE's will probable require globally installed linters and formatters, but I suppose it is ok. Let's start using and try.
