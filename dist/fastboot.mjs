function logDebug(...data) {
    {
        console.log(...data);
    }
}

function readBlobAsBuffer(blob) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => {
            resolve(reader.result);
        };
        reader.onerror = () => {
            reject(reader.error);
        };

        reader.readAsArrayBuffer(blob);
    });
}

const FILE_MAGIC = 0xed26ff3a;

const MAJOR_VERSION = 1;
const MINOR_VERSION = 0;
const FILE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

// AOSP libsparse uses 64 MiB chunks
const RAW_CHUNK_SIZE = 64 * 1024 * 1024;

const CHUNK_TYPE_RAW = 0xcac1;
const CHUNK_TYPE_FILL = 0xcac2;
const CHUNK_TYPE_SKIP = 0xcac3;

const CHUNK_TYPE_MAP = new Map();
CHUNK_TYPE_MAP.set(CHUNK_TYPE_RAW, "raw");
CHUNK_TYPE_MAP.set(CHUNK_TYPE_FILL, "fill");
CHUNK_TYPE_MAP.set(CHUNK_TYPE_SKIP, "skip");

class ImageError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

function parseFileHeader(buffer) {
    let view = new DataView(buffer);

    let magic = view.getUint32(0, true);
    if (magic !== FILE_MAGIC) {
        return null;
    }

    // v1.0+
    let major = view.getUint16(4, true);
    let minor = view.getUint16(6, true);
    if (major !== MAJOR_VERSION || minor < MINOR_VERSION) {
        throw new ImageError(`Unsupported sparse image version ${major}.${minor}`);
    }

    let fileHdrSize = view.getUint16(8, true);
    let chunkHdrSize = view.getUint16(10, true);
    if (fileHdrSize !== FILE_HEADER_SIZE || chunkHdrSize !== CHUNK_HEADER_SIZE) {
        throw new ImageError(`Invalid file header size ${fileHdrSize}, chunk header size ${chunkHdrSize}`);
    }

    let blockSize = view.getUint32(12, true);
    if (blockSize % 4 !== 0) {
        throw new ImageError(`Block size ${blockSize} is not a multiple of 4`);
    }

    return {
        blockSize: blockSize,
        blocks: view.getUint32(16, true),
        chunks: view.getUint32(20, true),
        crc32: view.getUint32(24, true),
    };
}

function parseChunkHeader(buffer) {
    let view = new DataView(buffer);

    // This isn't the same as what createImage takes.
    // Further processing needs to be done on the chunks.
    return {
        type: CHUNK_TYPE_MAP.get(view.getUint16(0, true)),
        /* 2: reserved, 16 bits */
        blocks: view.getUint32(4, true),
        dataBytes: view.getUint32(8, true) - CHUNK_HEADER_SIZE,
        data: null, // to be populated by consumer
    };
}

function calcChunksBlockSize(chunks) {
    return chunks.map(chunk => chunk.blocks)
        .reduce((total, c) => total + c, 0);
}

function calcChunksDataSize(chunks) {
    return chunks.map(chunk => chunk.data.byteLength)
        .reduce((total, c) => total + c, 0);
}

function calcChunksSize(chunks) {
    // 28-byte file header, 12-byte chunk headers
    let overhead = FILE_HEADER_SIZE + CHUNK_HEADER_SIZE * chunks.length;
    return overhead + calcChunksDataSize(chunks);
}

function createImage(header, chunks) {
    let buffer = new ArrayBuffer(calcChunksSize(chunks));
    let dataView = new DataView(buffer);
    let arrayView = new Uint8Array(buffer);

    dataView.setUint32(0, FILE_MAGIC, true);
    // v1.0
    dataView.setUint16(4, MAJOR_VERSION, true);
    dataView.setUint16(6, MINOR_VERSION, true);
    dataView.setUint16(8, FILE_HEADER_SIZE, true);
    dataView.setUint16(10, CHUNK_HEADER_SIZE, true);

    // Match input parameters
    dataView.setUint32(12, header.blockSize, true);
    dataView.setUint32(16, header.blocks, true);
    dataView.setUint32(20, chunks.length, true);

    // We don't care about the CRC. AOSP docs specify that this should be a CRC32,
    // but AOSP libsparse always sets 0 and puts the CRC in a final undocumented
    // 0xCAC4 chunk instead.
    dataView.setUint32(24, 0, true);

    let chunkOff = FILE_HEADER_SIZE;
    for (let chunk of chunks) {
        let typeMagic;
        if (chunk.type == "raw") {
            typeMagic = CHUNK_TYPE_RAW;
        } else if (chunk.type == "fill") {
            typeMagic = CHUNK_TYPE_FILL;
        } else if (chunk.type == "skip") {
            typeMagic = CHUNK_TYPE_SKIP;
        } else {
            // We don't support the undocumented 0xCAC4 CRC32 chunk type because
            // it's unnecessary and very rarely used in practice.
            throw new ImageError(`Invalid chunk type "${chunk.type}"`);
        }

        dataView.setUint16(chunkOff, typeMagic, true);
        dataView.setUint16(chunkOff + 2, 0, true); // reserved
        dataView.setUint32(chunkOff + 4, chunk.blocks, true);
        dataView.setUint32(chunkOff + 8, CHUNK_HEADER_SIZE + chunk.data.byteLength, true);
        chunkOff += CHUNK_HEADER_SIZE;

        let chunkArrayView = new Uint8Array(chunk.data);
        arrayView.set(chunkArrayView, chunkOff);
        chunkOff += chunk.data.byteLength;
    }

    return buffer;
}

/**
 * Checks whether the given buffer is a valid sparse image.
 *
 * @param {ArrayBuffer} buffer - Buffer containing the data to check.
 * @returns {valid} Whether the buffer is a valid sparse image.
 */
function isSparse(buffer) {
    try {
        let header = parseFileHeader(buffer);
        return header !== null;
    } catch (error) {
        // ImageError = invalid
        return false;
    }
}

/**
 * Creates a sparse image from buffer containing raw image data.
 *
 * @param {ArrayBuffer} rawBuffer - Buffer containing the raw image data.
 * @returns {sparseBuffer} Buffer containing the new sparse image.
 */
function fromRaw(rawBuffer) {
    let header = {
        blockSize: 4096,
        blocks: rawBuffer.byteLength / 4096,
        chunks: 1,
        crc32: 0,
    };

    let chunks = [];
    while (rawBuffer.byteLength > 0) {
        let chunkSize = Math.min(rawBuffer.byteLength, RAW_CHUNK_SIZE);
        chunks.push({
            type: "raw",
            blocks: chunkSize / header.blockSize,
            data: rawBuffer.slice(0, chunkSize),
        });
        rawBuffer = rawBuffer.slice(chunkSize);
    }

    return createImage(header, chunks);
}

/**
 * Split a sparse image into smaller sparse images within the given size.
 * This takes a Blob instead of an ArrayBuffer because it may process images
 * larger than RAM.
 *
 * @param {Blob} blob - Blob containing the sparse image to split.
 * @param {number} splitSize - Maximum size per split.
 */
async function* splitBlob(blob, splitSize) {
    logDebug(`Splitting ${blob.size}-byte sparse image into ${splitSize}-byte chunks`);
    // Short-circuit if splitting isn't required
    if (blob.size <= splitSize) {
        logDebug("Blob fits in 1 payload, not splitting");
        yield await readBlobAsBuffer(blob);
        return;
    }

    let headerData = await readBlobAsBuffer(blob.slice(0, FILE_HEADER_SIZE));
    let header = parseFileHeader(headerData);
    // Remove CRC32 (if present), otherwise splitting will invalidate it
    header.crc32 = 0;
    blob = blob.slice(FILE_HEADER_SIZE);

    let splitChunks = [];
    for (let i = 0; i < header.chunks; i++) {
        let chunkHeaderData = await readBlobAsBuffer(blob.slice(0, CHUNK_HEADER_SIZE));
        let chunk = parseChunkHeader(chunkHeaderData);
        chunk.data = await readBlobAsBuffer(blob.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + chunk.dataBytes));
        blob = blob.slice(CHUNK_HEADER_SIZE + chunk.dataBytes);

        let bytesRemaining = splitSize - calcChunksSize(splitChunks);
        logDebug(`  Chunk ${i}: type ${chunk.type}, ${chunk.dataBytes} bytes / ${chunk.blocks} blocks, ${bytesRemaining} bytes remaining`);
        if (bytesRemaining >= chunk.dataBytes) {
            // Read the chunk and add it
            logDebug("    Space is available, adding chunk");
            splitChunks.push(chunk);
        } else {
            // Out of space, finish this split
            // Blocks need to be calculated from chunk headers instead of going by size
            // because FILL and SKIP chunks cover more blocks than the data they contain.
            let splitBlocks = calcChunksBlockSize(splitChunks);
            splitChunks.push({
                type: "skip",
                blocks: header.blocks - splitBlocks,
                data: new ArrayBuffer(),
            });
            logDebug(`Partition is ${header.blocks} blocks, used ${splitBlocks}, padded with ${header.blocks - splitBlocks}, finishing split with ${calcChunksBlockSize(splitChunks)} blocks`);
            let splitImage = createImage(header, splitChunks);
            logDebug(`Finished ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`);
            yield splitImage;

            // Start a new split. Every split is considered a full image by the
            // bootloader, so we need to skip the *total* written blocks.
            logDebug(`Starting new split: skipping first ${splitBlocks} blocks and adding chunk`);
            splitChunks = [
                {
                    type: "skip",
                    blocks: splitBlocks,
                    data: new ArrayBuffer(),
                },
                chunk,
            ];
        }
    }

    // Finish the final split if necessary
    if (splitChunks.length > 0 &&
            (splitChunks.length > 1 || splitChunks[0].type !== "skip")) {
        let splitImage = createImage(header, splitChunks);
        logDebug(`Finishing final ${splitImage.byteLength}-byte split with ${splitChunks.length} chunks`);
        yield splitImage;
    }
}

const FASTBOOT_USB_CLASS = 0xff;
const FASTBOOT_USB_SUBCLASS = 0x42;
const FASTBOOT_USB_PROTOCOL = 0x03;

const BULK_TRANSFER_SIZE = 16384;

const DEFAULT_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB
// To conserve RAM and work around Chromium's ~2 GiB size limit, we limit the
// max download size even if the bootloader can accept more data.
const MAX_DOWNLOAD_SIZE = 1024 * 1024 * 1024; // 1 GiB

/** Exception class for USB or WebUSB-level errors. */
class UsbError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

/** Exception class for bootloader and high-level fastboot errors. */
class FastbootError extends Error {
    constructor(status, message) {
        super(`Bootloader replied with ${status}: ${message}`);
        this.status = status;
        this.bootloaderMessage = message;
        this.name = this.constructor.name;
    }
}

/**
 * Implements fastboot commands and operations for a device connected over USB.
 */
class FastbootDevice {
    /**
     * Creates a new fastboot device object ready to connect to a USB device.
     * This does not actually connect to any devices.
     *
     * @see connect
     */
    constructor() {
        this.device = null;
    }

    get isConnected() {
        return this.device !== null;
    }

    /**
     * Request the user to select a USB device and attempt to connect to it
     * using the fastboot protocol.
     *
     * @throws {UsbError}
     */
    async connect() {
        this.device = await navigator.usb.requestDevice({
            filters: [
                {
                    classCode: FASTBOOT_USB_CLASS,
                    subclassCode: FASTBOOT_USB_SUBCLASS,
                    protocolCode: FASTBOOT_USB_PROTOCOL,
                },
            ],
        });
        logDebug("Got USB device:", this.device);

        // Validate device
        let ife = this.device.configurations[0].interfaces[0].alternates[0];
        if (ife.endpoints.length !== 2) {
            throw new UsbError("Interface has wrong number of endpoints");
        }

        let epIn = null;
        let epOut = null;
        for (let endpoint of ife.endpoints) {
            logDebug("Checking endpoint:", endpoint);
            if (endpoint.type !== "bulk") {
                throw new UsbError("Interface endpoint is not bulk");
            }

            if (endpoint.direction == "in") {
                if (epIn == null) {
                    epIn = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple IN endpoints");
                }
            } else if (endpoint.direction == "out") {
                if (epOut == null) {
                    epOut = endpoint.endpointNumber;
                } else {
                    throw new UsbError("Interface has multiple OUT endpoints");
                }
            }
        }
        logDebug("Endpoints: in =", epIn, ", out =", epOut);

        await this.device.open();
        // Opportunistically reset to fix issues on some platforms
        try {
            await this.device.reset();
        } catch (error) { /* Failed = doesn't support reset */ }

        await this.device.selectConfiguration(1);
        await this.device.claimInterface(0); // fastboot
    }

    /**
     * Reads a raw command response from the bootloader.
     *
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async _readResponse() {
        let returnData = {
            text: "",
            dataSize: null,
        };
        let response;
        do {
            let respPacket = await this.device.transferIn(0x01, 64);
            response = new TextDecoder().decode(respPacket.data);
            logDebug("response: packet", respPacket, "string", response);

            if (response.startsWith("OKAY")) {
                // OKAY = end of response for this command
                returnData.text += response.substring(4);
            } else if (response.startsWith("INFO")) {
                // INFO = additional info line
                returnData.text += response.substring(4) + "\n";
            } else if (response.startsWith("DATA")) {
                // DATA = hex string, but it"s returned separately for safety
                returnData.dataSize = response.substring(4);
            } else {
                // Assume FAIL or garbage data
                throw new FastbootError(response.substring(0, 4), response.substring(4));
            }
        // INFO means that more packets are coming
        } while (response.startsWith("INFO"));

        return returnData;
    }

    /**
     * Sends a textual command to the bootloader.
     * This is in raw fastboot format, not AOSP fastboot syntax.
     *
     * @param {string} command - The command to send.
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async runCommand(command) {
        // Command and response length is always 64 bytes regardless of protocol
        if (command.length > 64) {
            throw new RangeError();
        }

        // Send raw UTF-8 command
        let cmdPacket = new TextEncoder("utf-8").encode(command);
        await this.device.transferOut(0x01, cmdPacket);
        logDebug("command:", command);

        return this._readResponse();
    }

    /**
     * Returns the value of a bootloader variable.
     *
     * @param {string} varName - The name of the variable to get.
     * @returns {value} Textual content of the variable.
     * @throws {FastbootError}
     */
    async getVariable(varName) {
        let resp = (await this.runCommand(`getvar:${varName}`)).text;
        // Some bootloaders send whitespace around some variables
        resp = resp.trim();
        // According to the spec, non-existent variables should return empty
        // responses
        if (resp) {
            return resp;
        } else {
            // Throw an error for compatibility reasons
            throw new FastbootError("FAIL", "No such variable (OKAY)");
        }
    }

    /**
     * Returns the maximum download size for a single payload, in bytes.
     *
     * @private
     * @returns {downloadSize}
     * @throws {FastbootError}
     */
    async _getDownloadSize() {
        try {
            let resp = (await this.getVariable("max-download-size")).toLowerCase();
            if (resp) {
                // AOSP fastboot requires hex
                return Math.min(parseInt(resp, 16), MAX_DOWNLOAD_SIZE);
            }
        } catch (error) { /* Failed = no value, fallthrough */ }

        // FAIL or empty variable means no max, set a reasonable limit to conserve memory
        return DEFAULT_DOWNLOAD_SIZE;
    }

    /**
     * Reads a raw command response from the bootloader.
     *
     * @private
     * @returns {response} Object containing response text and data size, if any.
     * @throws {FastbootError}
     */
    async _sendRawPayload(buffer) {
        let i = 0;
        let remainingBytes = buffer.byteLength;
        while (remainingBytes > 0) {
            let chunk = buffer.slice(i * BULK_TRANSFER_SIZE, (i + 1) * BULK_TRANSFER_SIZE);
            if (i % 1000 == 0) {
                logDebug(`  Sending ${chunk.byteLength} bytes to endpoint, ${remainingBytes} remaining, i=${i}`);
            }
            await this.device.transferOut(0x01, chunk);

            remainingBytes -= chunk.byteLength;
            i += 1;
        }

        logDebug(`Finished sending payload, ${remainingBytes} bytes remaining`);
    }

    /**
     * Flashes a single sparse payload.
     * Does not handle raw images or splitting.
     *
     * @private
     * @throws {FastbootError}
     */
    async _flashSingleSparse(partition, buffer) {
        logDebug(`Flashing single sparse to ${partition}: ${buffer.byteLength} bytes`);

        // Bootloader requires an 8-digit hex number
        let xferHex = buffer.byteLength.toString(16).padStart(8, "0");
        if (xferHex.length !== 8) {
            throw new FastbootError("FAIL", `Transfer size overflow: ${xferHex} is more than 8 digits`);
        }

        // Check with the device and make sure size matches
        let downloadResp = await this.runCommand(`download:${xferHex}`);
        if (downloadResp.dataSize == null) {
            throw new FastbootError("FAIL", `Unexpected response to download command: ${downloadResp.text}`);
        }
        let downloadSize = parseInt(downloadResp.dataSize, 16);
        if (downloadSize !== buffer.byteLength) {
            throw new FastbootError("FAIL", `Bootloader wants ${buffer.byteLength} bytes, requested to send ${buffer.bytelength} bytes`);
        }

        logDebug(`Sending payload: ${buffer.byteLength} bytes`);
        await this._sendRawPayload(buffer);

        logDebug("Payload sent, waiting for response...");
        await this._readResponse();

        logDebug("Flashing payload...");
        await this.runCommand(`flash:${partition}`);
    }

    /**
     * Flashes the given File or Blob to the given partition on the device.
     *
     * @param {string} partition - The name of the partition to flash.
     * @param {Blob} blob - The Blob to retrieve data from.
     * @throws {FastbootError}
     */
    async flashBlob(partition, blob) {
        // Use current slot if partition is A/B
        try {
            if (await this.getVariable(`has-slot:${partition}`) == "yes") {
                partition += "_" + await this.getVariable("current-slot");
            }
        } catch (error) { /* Failed = not A/B, fallthrough */ }

        let maxDlSize = await this._getDownloadSize();

        // Convert image to sparse (for splitting) if it exceeds the size limit
        let fileHeader = await readBlobAsBuffer(blob.slice(0, FILE_HEADER_SIZE));
        if (blob.size > maxDlSize && !isSparse(fileHeader)) {
            logDebug(`${partition} image is raw, converting to sparse`);

            // Assume that non-sparse images will always be small enough to convert in RAM.
            // The buffer is converted to a Blob for compatibility with the existing flashing code.
            let rawData = await readBlobAsBuffer(blob);
            let sparse = fromRaw(rawData);
            blob = new Blob([sparse]);
        }

        logDebug(`Flashing ${blob.size} bytes to ${partition}, ${maxDlSize} bytes per split`);
        let splits = 0;
        for await (let splitBuffer of splitBlob(blob, maxDlSize)) {
            await this._flashSingleSparse(partition, splitBuffer, maxDlSize);
            splits += 1;
        }

        logDebug(`Flashed ${partition} with ${splits} split(s)`);
    }
}

const DB_NAME = "BlobStore";
const DB_VERSION = 1;

class BlobStore {
    constructor() {
        this.db = null;
    }

    async _wrapReq(request, onUpgrade = null) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                resolve(request.result);
            };
            request.oncomplete = () => {
                resolve(request.result);
            };
            request.onerror = (event) => {
                reject(event);
            };

            if (onUpgrade !== null) {
                request.onupgradeneeded = onUpgrade;
            }
        });
    }

    async init() {
        this.db = await this._wrapReq(indexedDB.open(DB_NAME, DB_VERSION), (event) => {
            let db = event.target.result;
            db.createObjectStore("files", { keyPath: "name" });
            /* no index needed for such a small database */
        });
    }

    async saveFile(name, blob) {
        this.db.transaction(["files"], "readwrite").objectStore("files").add({
            name: name,
            blob: blob,
        });
    }

    async loadFile(name) {
        try {
            let obj = await this._wrapReq(this.db.transaction("files").objectStore("files").get(name));
            return obj.blob;
        } catch (error) {
            return null;
        }
    }

    async close() {
        this.db.close();
    }
}

async function downloadZip(url) {
    // Open the DB first to get user consent
    let store = new BlobStore();
    await store.init();

    let filename = url.split("/").pop();
    let blob = await store.loadFile(filename);
    if (blob == null) {
        logDebug(`Downloading ${url}`);
        let resp = await fetch(new Request(url));
        blob = await resp.blob();
        logDebug("File downloaded, saving...");
        await store.saveFile(filename, blob);
        logDebug("File saved");
    } else {
        logDebug(`Loaded ${filename} from blob store, skipping download`);
    }

    store.close();
    return blob;
}

// zip.js is loaded separately.
/* eslint-disable no-undef */
async function flashEntryBlob(device, entry, progressCallback, partition) {
    progressCallback("unpack", partition);
    let blob = await entry.getData(new zip.BlobWriter("application/octet-stream"));
    progressCallback("flash", partition);
    await device.flashBlob(partition, blob);
}

async function flashZip(device, name, progressCallback = () => {}) {
    let store = new BlobStore();
    await store.init();

    logDebug(`Loading ${name} as zip`);
    let reader = new zip.ZipReader(new zip.BlobReader(await store.loadFile(name)));
    let entries = await reader.getEntries();
    for (let entry of entries) {
        if (entry.filename.match(/avb_pkmd.bin$/)) {
            logDebug("Flashing AVB custom key");
            await flashEntryBlob(device, entry, progressCallback, "avb_custom_key");
        } else if (entry.filename.match(/bootloader-.+\.img$/)) {
            logDebug("Flashing bootloader image pack");
            await flashEntryBlob(device, entry, progressCallback, "bootloader");
        } else if (entry.filename.match(/radio-.+\.img$/)) {
            logDebug("Flashing radio image pack");
            await flashEntryBlob(device, entry, progressCallback, "radio");
        } else if (entry.filename.match(/image-.+\.zip$/)) {
            logDebug("Flashing images from nested images zip");

            let imagesBlob = await entry.getData(new zip.BlobWriter("application/zip"));
            let imageReader = new zip.ZipReader(new zip.BlobReader(imagesBlob));
            for (let image of await imageReader.getEntries()) {
                if (!image.filename.endsWith(".img")) {
                    continue;
                }

                logDebug(`Flashing ${image.filename} from images zip`);
                let partition = image.filename.replace(".img", "");
                await flashEntryBlob(device, image, progressCallback, partition);
            }
        }
    }

    store.close();
}

var factory = /*#__PURE__*/Object.freeze({
    __proto__: null,
    downloadZip: downloadZip,
    flashZip: flashZip
});

export { factory as Factory, FastbootDevice };