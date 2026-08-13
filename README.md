# Bloom's Public Reports Prototype

Interactive bloom report, published as a GitHub pages website via GitHub actions. 

`main` branch is published on push.

## Layout

| Path                           | Role                                                                   |
|--------------------------------|------------------------------------------------------------------------|
| `index.template.html`          | The app — markup, CSS, and JS. Edit this for anything that isn't data. |
| `data/`                        | JSON data files                                                        |
| `static/`                      | SVG icons.                                                             |
| `build.js`                     | Injects the JSON into the template, writes `dist/`.                    |
| `dist/`                        | Build output. Gitignored; regenerated on every deploy.                 |

## Local preview

```sh
node build.js && (cd dist && python3 -m http.server 8000)
```
Then open http://localhost:8000/. 

