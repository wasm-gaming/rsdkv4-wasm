
import { C79 } from 'https://jgermade.github.io/jq79/jq79.js'

C79.fetch('./app.html')
    .mount('body > main')
    .catch(err => {
        console.error('Failed to load app.html:', err)
    })