## OpenAnime Release Server Publisher

`@openanime/release-server-publisher` publishes all your artifacts to a hosted instance of [OpenAnime Release Server](https://github.com/OpenAnime/release-server) where users will be able to download them.

```javascript title=forge.config.js
module.exports = {
    // ...
    publishers: [
        {
            name: '@openanime/release-server-publisher',
            config: {
                baseUrl: 'https://update.server.com',
                username: 'admin',
                password: 'admin',
            },
        },
    ],
};
```
