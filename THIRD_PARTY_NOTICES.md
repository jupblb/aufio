# Third-party notices

The KA17 packet layout, preset mapping, gain encoding and gain-dependent peaking
Q convention are adapted from / informed by
[devicePEQ](https://github.com/jeromeof/devicePEQ/tree/0617f382e76629792a5933e6933e4b396a756a93),
particularly `devicePEQ/fiioUsbHidHandler.js` (header: Copyright 2024 Pragmatic
Audio), `usbDeviceConfig.js`, and the included protocol captures. No vendor
application bundle is distributed with aufio.

The reference project's `LICENSE.txt` states:

```text
Copyright 2024 Jerome O'Flaherty (jerome.oflaherty@icloud.com)

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

Installed npm dependencies retain their own license notices, including
`node-hid` and its bundled HIDAPI implementation. See their package contents.
