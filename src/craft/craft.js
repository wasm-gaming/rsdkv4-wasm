
import { C79 } from 'https://jgermade.github.io/jq79/jq79.js'

// The file is App.html. Fetching './app.html' worked on macOS and 404s on GitHub
// Pages, which is case-sensitive — the kind of break that only shows up once it
// is deployed.
C79.fetch('./App.html')
    .mount('body > main')
    .catch(err => {
        console.error('Failed to load App.html:', err)
    })