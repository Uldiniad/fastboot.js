import * as common from "./common";
import {
    ZipReader,
    BlobReader,
    BlobWriter,
} from "@zip.js/zip.js";
import type {
    Entry,
} from "@zip.js/zip.js";
import { FastbootDevice, FastbootError } from "./fastboot";
import type { ReconnectCallback } from "./fastboot";

/**
 * Callback for factory image flashing progress.
 *
 * @callback FactoryProgressCallback
 * @param {string} action - Action in the flashing process, e.g. unpack/flash.
 * @param {string} item - Item processed by the action, e.g. partition being flashed.
 * @param {number} progress - Progress within the current action between 0 and 1.
 */
export type FactoryProgressCallback = (
    action: string,
    item: string,
    progress: number
) => void;

// Images needed for fastbootd
const BOOT_CRITICAL_IMAGES = [
    "vbmeta",
];

// Less critical images to flash after boot-critical ones
const SYSTEM_IMAGES = [
    "system",
];

/**
 * User-friendly action strings for factory image flashing progress.
 * This can be indexed by the action argument in FactoryFlashCallback.
 */
export const USER_ACTION_MAP = {
    load: "Loading",
    unpack: "Unpacking",
    flash: "Writing",
    wipe: "Wiping",
    reboot: "Restarting",
};

const BOOTLOADER_REBOOT_TIME = 4000; // ms
const FASTBOOTD_REBOOT_TIME = 16000; // ms
const USERDATA_ERASE_TIME = 1000; // ms

async function flashEntryBlob(
    device: FastbootDevice,
    entry: Entry,
    onProgress: FactoryProgressCallback,
    partition: string
) {
    common.logDebug(`Unpacking ${partition}`);
    onProgress("unpack", partition, 0.0);
    const blob: Blob = await common.zipGetData(
        entry,
        new BlobWriter("application/octet-stream"),
        {
            onprogress: (bytes: number, len: number) => {
                onProgress("unpack", partition, bytes / len);
                return undefined;
            },
        }
    );

    common.logDebug(`Flashing ${partition}`);
    onProgress("flash", partition, 0.0);
    await device.flashBlob(partition, blob, (progress) => {
        onProgress("flash", partition, progress);
    });
}

async function tryFlashImages(
    device: FastbootDevice,
    entries: Array<Entry>,
    onProgress: FactoryProgressCallback,
    imageNames: Array<string>
) {
    for (const imageName of imageNames) {
        const pattern = new RegExp(`${imageName}(?:-.+)?\\.img$`);
        const entry = entries.find((entry) => entry.filename.match(pattern));
        if (entry !== undefined) {
            if (imageName == "bootloader") {
                const current_slot = await device.getVariable("current-slot");
                if (current_slot == "a") {
                    await flashEntryBlob(device, entry, onProgress, (imageName + "_b"));
                    await device.runCommand("set_active:b");
                } else if (current_slot == "b") {
                    await flashEntryBlob(device, entry, onProgress, (imageName + "_a"));
                    await device.runCommand("set_active:a");
                } else {
                    throw new FastbootError(
                        "FAIL",
                        `Invalid slot given by bootloader.`
                    );
                }
            }
            else {
                await flashEntryBlob(device, entry, onProgress, imageName);
            }
        }
    }
}

export async function flashZip(
    device: FastbootDevice,
    blob: Blob,
    wipe: boolean,
    onReconnect: ReconnectCallback,
    onProgress: FactoryProgressCallback = () => {}
) {
    onProgress("load", "package", 0.0);
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    
    if ((await device.getVariable("is-userspace")) === "yes") {
        await device.reboot("bootloader", true, onReconnect);
    }

    // Cancel snapshot update if in progress
    const snapshotStatus = await device.getVariable("snapshot-update-status");
    if (snapshotStatus !== null && snapshotStatus !== "none") {
        await device.runCommand("snapshot-update:cancel");
    }

    // Boot-critical images
    await tryFlashImages(
        device,
        entries,
        onProgress,
        BOOT_CRITICAL_IMAGES
    );

    // Reboot to fastbootd
    await common.runWithTimedProgress(
        onProgress,
        "reboot",
        "device",
        FASTBOOTD_REBOOT_TIME,
        device.reboot("fastboot", true, onReconnect)
    );
    
    if ((await device.getVariable("is-userspace")) !== "yes") {
        throw new FastbootError(
            "FAIL",
            `Requirement is-userspace=yes failed`
        );
    }

    if (wipe) {
        try {
            await device.runCommand("erase:system_a");
        } catch (e) {
            // Ignore
        }
        try {
            await device.runCommand("erase:system_b");
        } catch (e) {
            // Ignore
        }
        try {
            await device.runCommand("delete-logical-partition:product_a");
        } catch (e) {
            // Ignore
        }
        try {
            await device.runCommand("delete-logical-partition:product_b");
        } catch (e) {
            // Ignore
        }
        try {
            await device.runCommand("delete-logical-partition:system_ext_a");
        } catch (e) {
            // Ignore
        }
        try {
            await device.runCommand("delete-logical-partition:system_ext_b");
        } catch (e) {
            // Ignore
        }
    }

    // System images
    await tryFlashImages(device, entries, onProgress, SYSTEM_IMAGES);

    // We unconditionally reboot back to the bootloader here if we're in fastbootd,
    // even when there's no custom AVB key, because common follow-up actions like
    // locking the bootloader and wiping data need to be done in the bootloader.
    if ((await device.getVariable("is-userspace")) === "yes") {
        await common.runWithTimedProgress(
            onProgress,
            "reboot",
            "device",
            BOOTLOADER_REBOOT_TIME,
            device.reboot("bootloader", true, onReconnect)
        );
    }

    // Custom AVB key
    const entry = entries.find((e) => e.filename.endsWith("avb_pkmd.bin"));
    if (entry !== undefined) {
        await device.runCommand("erase:avb_custom_key");
        await flashEntryBlob(device, entry, onProgress, "avb_custom_key");
    }

    // Wipe userdata
    if (wipe) {
        await common.runWithTimedProgress(
            onProgress,
            "wipe",
            "data",
            USERDATA_ERASE_TIME,
            device.runCommand("erase:userdata")
        );
    }
}
