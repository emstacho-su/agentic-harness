# Windows Path Gotcha

Native Windows binaries cannot read MSYS-style paths. `node.exe` silently resolves
`/c/Users/me/thing` to `C:\c\Users\me\thing` and then fails with ENOENT, which reads like
a missing file rather than a path-translation bug.

Pass `C:/Users/...` to any native binary. Only the bash shell itself understands the
`/c/...` form, so a script that needs both should bind two separate variables.
