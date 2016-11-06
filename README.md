## About
Discord Raw is a small library written specifically for anyone who only wants to listen to Discord events. It's main task is to take connecting to the Discord gateway off your shoulders, so that you can focus on processing the data instead. The library also comes with session resuming capabilities, which means that you don't have to lose any data.

This library runs only on node.js v6 and newer.

## Installation
`npm install discord-raw --save`

That's it! Now you can use it in your project.

## Examples
```javascript
const DiscordRaw = require('discord-raw');

var bot = new DiscordRaw({
    token: 'xxx',
    shard: [0, 1]
});

bot.on(DiscordRaw.EVENT_EVENT, event => {
    // Process the data however you want to

    if (event.t === 'MESSAGE_CREATE') {
        console.log(`#${event.d.channel_id} ${event.d.author.username}: ${event.d.content}`);
    }
});
```
