import { readSync, statSync, openSync, closeSync } from 'node:fs';

import { basename } from 'pathe';
import { ofetch } from 'ofetch';
import consola from 'consola';

import { PublisherBase, type PublisherOptions } from '@electron-forge/publisher-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

export type ORSChannel = 'stable' | 'beta' | 'alpha' | 'rc';

export interface PublisherOpenAnimeConfig {
    baseUrl: string;
    username: string;
    password: string;
    channel?: ORSChannel;
    chunkSizeInMb?: number;
}

export interface ORSAsset {
    name: string;
    platform: ForgePlatform;
}

export interface ORSRelease {
    version: string;
    channel: ORSChannel;
    changeLog: string;
    createdAt: string;
    assets: ORSAsset[];
}

export default class PublisherOpenAnime extends PublisherBase<PublisherOpenAnimeConfig> {
    name = 'openanime-release-server';

    async publish({ makeResults, setStatusLine }: PublisherOptions): Promise<void> {
        const { config } = this;

        if (!config.baseUrl || !config.username || !config.password) {
            consola.error(new Error('Missing required configuration options for ORS'));
        }

        consola.info('Attempting to authenticate to ORS');

        const apiFetch = ofetch.create({ baseURL: `${config.baseUrl}/api` });

        try {
            const { jwt } = await apiFetch<{ jwt: string }>('/login', {
                method: 'POST',
                body: {
                    username: config.username,
                    password: config.password,
                },
            });

            for (const makeResult of makeResults) {
                const { packageJSON } = makeResult;

                const artifacts = makeResult.artifacts.filter(
                    (artifactPath) => basename(artifactPath).toLowerCase() !== 'releases',
                );

                let channel = 'stable';
                if (config.channel) {
                    channel = config.channel;
                } else if (packageJSON.version.includes('rc')) {
                    channel = 'rc';
                } else if (packageJSON.version.includes('beta')) {
                    channel = 'beta';
                } else if (packageJSON.version.includes('alpha')) {
                    channel = 'alpha';
                }

                const version = packageJSON.version.replace(/-(stable|beta|alpha|rc)/, '');

                const releases = await apiFetch<ORSRelease[]>('/releases');

                const existingRelease = releases.find(
                    (release) => release.version === version && release.channel === channel,
                );

                if (!existingRelease) {
                    try {
                        await apiFetch('/releases', {
                            method: 'POST',
                            body: {
                                version,
                                channel,
                                changeLog: 'Electron Forge Release',
                            },
                            headers: {
                                Authorization: jwt,
                            },
                        });

                        consola.success(`Release ${version} created on server`);
                    } catch {
                        consola.error(new Error('Failed to create release on server'));
                    }
                }

                let uploaded = 0;

                const updateStatusLine = () => {
                    setStatusLine(`Uploading distributable (${uploaded}/${artifacts.length})`);
                };

                updateStatusLine();

                await Promise.all(
                    artifacts.map(async (artifactPath: string) => {
                        const fileName = basename(artifactPath);

                        if (existingRelease) {
                            const existingAsset = existingRelease.assets.find(
                                (asset) =>
                                    asset.name === fileName &&
                                    asset.platform === makeResult.platform,
                            );

                            if (existingAsset) {
                                consola.info(`Asset ${fileName} already exists on server`);

                                uploaded++;
                                updateStatusLine();

                                return;
                            }
                        }

                        consola.info(`Uploading asset ${fileName} to server`);

                        const fileChunkSize = config.chunkSizeInMb * 1024 * 1024;

                        const fileSize = statSync(artifactPath).size;
                        const totalChunks = Math.ceil(fileSize / fileChunkSize);

                        for (let i = 0; i < totalChunks; i++) {
                            let buffer = Buffer.alloc(fileChunkSize);
                            const fileDescriptor = openSync(artifactPath, 'r');

                            try {
                                const bytesRead = readSync(fileDescriptor, buffer, {
                                    length: fileChunkSize,
                                    position: i * fileChunkSize,
                                });

                                if (bytesRead < fileChunkSize) {
                                    buffer = buffer.subarray(0, bytesRead);
                                }
                            } finally {
                                closeSync(fileDescriptor);
                            }

                            const formData = new FormData();

                            formData.append('currentChunk', (i + 1).toString());
                            formData.append('totalChunks', totalChunks.toString());
                            formData.append('platform', makeResult.platform);
                            formData.append('file', new Blob([buffer]), basename(artifactPath));

                            try {
                                await apiFetch(`/releases/${channel}/${version}/assets`, {
                                    method: 'POST',
                                    body: formData,
                                    headers: {
                                        Authorization: jwt,
                                    },
                                });

                                consola.success(`Asset ${fileName} uploaded to server`);
                            } catch {
                                consola.error(new Error('Failed to upload asset to server'));
                            }
                        }

                        uploaded++;
                        updateStatusLine();
                    }),
                );
            }
        } catch {
            consola.error(new Error('Invalid credentials for ORS'));
        }
    }
}
