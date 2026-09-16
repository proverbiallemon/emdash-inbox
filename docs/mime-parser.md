# MIME parser byte preservation

The plugin uses a reviewed, bundled copy of **postal-mime 2.7.4**. Its upstream
7bit/8bit/binary decoder appends LF after every line, and its quoted-printable
and calendar paths can change attachment bytes. The local patch preserves raw
line terminators, excludes only the multipart boundary separator, decodes
quoted-printable into bytes, and retains calendar bytes and declared charset.
Base64 decoding remains upstream. Inline forwarded messages recursively use
the same corrected parser.

`patches/postal-mime@2.7.4.patch` is applied by pnpm for development. The generated
`vendor/postal-mime.mjs` is also checked in, so npm Git installs and published
packages use the fix without altering any host dependency. `src/lib/mimeParser.ts`
loads that copy directly; tsdown bundles it into the plugin. The package includes
the vendor source, original MIT-0 license, patch, and generation script.

To regenerate after reviewing a parser change:

```sh
pnpm install
pnpm vendor:mime
pnpm test tests/postal-mime-bytes.test.ts
pnpm build
```

The generation command rejects an unpatched installed parser. Build and prepare
verify the exact pinned version, patch SHA-256, generated bundle SHA-256, and a
byte-preservation probe. An npm Git build checks the existing vendor copy; it
does not regenerate it or depend on pnpm patch support. Update the explicit
version guard in `scripts/vendor-mime.mjs` when reviewing a future upgrade.

The byte regression suite runs against both the patched package and the vendor
used in production, covering line endings, binary and quoted-printable data,
nested multiparts, forwarded mail, calendar files, and EOF handling. Existing
stored files are not rewritten; this fix applies when new mail is parsed.
