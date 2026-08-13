# Bloom's Public Reports Prototype

Interactive bloom report, published as a GitHub pages website via GitHub actions. 

`main` branch is published on push.

## Layout

| Path                           | Role                                                                   |
|--------------------------------|------------------------------------------------------------------------|
| `src/app.js`                   | The app code.                                                          |
| `src/app.css`                  | The styles.                                                            |
| `index.template.html`          | Markup only. The rest is inlined into it at build time.                |
| `data/`                        | JSON data files                                                        |
| `static/`                      | SVG icons.                                                             |
| `build.js`                     | Inlines `src/` and the JSON into the template, writes `dist/`.         |
| `dist/`                        | Build output. Gitignored; regenerated on every deploy.                 |

The build produces one self-contained `index.html` — no external CSS or JS requests.

## Local preview

```sh
node build.js && (cd dist && python3 -m http.server 8000)
```
Then open http://localhost:8000/. 

