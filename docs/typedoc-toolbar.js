// Makes the toolbar's own-site links work wherever the docs are being served.
//
// TypeDoc relativises the links it generates itself, but `navigationLinks` are
// emitted verbatim — one string has to serve every page. That string cannot be
// right on its own: the pages sit at two depths (`/index.html` and
// `/classes/*.html`), so `./craft/` breaks on the deeper ones; and the published
// site is a project page under `/rsdkv4-wasm/`, so `/craft/` breaks there.
//
// So the links are written as absolute published URLs — correct on the real site
// with no JavaScript at all — and rewritten here when the page is being served
// from anywhere else, which is what `make up` and any preview deploy are. The
// path back to the docs root comes from TypeDoc's own title link, the one link
// on the page it has already relativised for us.
const SITE = 'https://wasm-gaming.github.io/rsdkv4-wasm/'

if (!location.href.startsWith(SITE)) {
  const title = document.querySelector('.tsd-page-toolbar a.title')
  const root = (title?.getAttribute('href') ?? 'index.html').replace(/index\.html$/, '')

  for (const link of document.querySelectorAll('#tsd-toolbar-links a')) {
    const href = link.getAttribute('href') ?? ''
    // Only our own site: Contract and GitHub live elsewhere and stay put.
    if (href.startsWith(SITE)) link.setAttribute('href', root + href.slice(SITE.length))
  }
}
