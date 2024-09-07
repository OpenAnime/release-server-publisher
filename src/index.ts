import { readSync, statSync, openSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import pino from 'pino';
import pretty from 'pino-pretty';
import axios, { Axios } from 'axios';
import axiosRetry from 'axios-retry';

const logger = pino(
    {
        level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
        customLevels: {
            success: 35, // info + 5
        },
    },
    pretty(),
);

import { PublisherBase, type PublisherOptions } from '@electron-forge/publisher-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

export type ReleaseChannel = 'stable' | 'beta' | 'alpha' | 'rc';

export interface PublisherOpenAnimeConfig {
    baseUrl: string;
    username: string;
    password: string;
    channel?: ReleaseChannel;
    chunkSizeInMb?: number;
}

export interface ReleaseAsset {
    name: string;
    platform: ForgePlatform;
}

export interface ReleaseInfo {
    version: string;
    channel: ReleaseChannel;
    changeLog: string;
    createdAt: string;
    assets: ReleaseAsset[];
}

export default class PublisherOpenAnime extends PublisherBase<PublisherOpenAnimeConfig> {
    name = 'openanime-release-server';

    async publish({ makeResults, setStatusLine }: PublisherOptions): Promise<void> {
        const {
            baseUrl,
            username,
            password,
            channel: configuredChannel,
            chunkSizeInMb: chunkSizeMb = 10,
        } = this?.config ?? {};

        if (!baseUrl || !username || !password) {
            return logger.error('Missing required configuration options for release server');
        }

        logger.info('Attempting to authenticate with release server');

        const apiClient = axios.create({ baseURL: `${baseUrl}/api` });

        axiosRetry(apiClient, { retries: 3 });

        try {
            const {
                data: { jwt },
            } = await apiClient.post<{ jwt: string }>('/login', {
                username,
                password,
            });

            for (const makeResult of makeResults) {
                const { packageJSON, artifacts, platform } = makeResult;

                const validArtifacts = artifacts.filter(
                    (artifactPath) => basename(artifactPath).toLowerCase() !== 'releases',
                );

                const channel = configuredChannel ?? this.extractChannel(packageJSON.version);
                const version = this.extractVersion(packageJSON.version, channel);
                const { data: releases } = await apiClient.get<ReleaseInfo[]>('/releases');

                const existingRelease = releases.find(
                    (release) => release.version === version && release.channel === channel,
                );

                if (!existingRelease) await this.createRelease(apiClient, version, channel, jwt);

                let uploadedCount = 0;

                const updateStatus = () =>
                    setStatusLine(
                        `Uploading artifact (${++uploadedCount}/${validArtifacts.length})`,
                    );

                await Promise.all(
                    validArtifacts.map(async (artifactPath) => {
                        const fileName = basename(artifactPath);

                        if (
                            existingRelease &&
                            this.doesAssetExist(existingRelease, fileName, platform)
                        ) {
                            logger.info(`Asset ${fileName} already exists on the server`);
                            return updateStatus();
                        }

                        const uploadSuccess = await this.uploadAsset(
                            apiClient,
                            artifactPath,
                            fileName,
                            version,
                            channel,
                            platform,
                            jwt,
                            chunkSizeMb,
                        );

                        if (uploadSuccess) {
                            logger.success(`Asset ${fileName} uploaded successfully`);
                        } else {
                            logger.error(`Failed to upload asset ${fileName}`);
                        }

                        updateStatus();
                    }),
                );
            }
        } catch {
            logger.error(new Error('Invalid credentials for release server'));
        }
    }

    extractChannel(version: string): ReleaseChannel {
        return ['stable', 'beta', 'alpha', 'rc'].find((c) => version.includes(c)) as ReleaseChannel;
    }

    extractVersion(version: string, channel: ReleaseChannel): string {
        return version.replace(`-${channel}`, '');
    }

    async createRelease(apiClient: Axios, version: string, channel: ReleaseChannel, jwt: string) {
        try {
            if (
                (
                    await apiClient.post(
                        '/releases',
                        {
                            version,
                            channel,
                            changeLog: 'Electron Forge Release',
                        },
                        {
                            headers: { Authorization: jwt },
                        },
                    )
                ).status !== 201
            )
                throw new Error();

            logger.success(`Release ${version} created successfully`);
        } catch {
            logger.error('Failed to create release on the server');
        }
    }

    doesAssetExist(existingRelease: ReleaseInfo, fileName: string, platform: ForgePlatform) {
        return existingRelease.assets.some(
            (asset) => asset.name === fileName && asset.platform === platform,
        );
    }

    async uploadAsset(
        apiClient: Axios,
        artifactPath: string,
        fileName: string,
        version: string,
        channel: ReleaseChannel,
        platform: ForgePlatform,
        jwt: string,
        chunkSizeMb: number,
    ): Promise<boolean> {
        const fileChunkSize = chunkSizeMb * 1024 * 1024;
        const totalChunks = Math.ceil(statSync(artifactPath).size / fileChunkSize);

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
            formData.append('platform', platform);
            formData.append('file', new Blob([buffer]), fileName);

            try {
                await apiClient.post(`/releases/${channel}/${version}/assets`, formData, {
                    headers: { Authorization: jwt },
                });
            } catch {
                return false;
            }
        }

        return true;
    }
}
