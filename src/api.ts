/// <reference types="node" />

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { exec } from "child_process";
import https from 'https';
import http from 'http';

// Type declaration for Node.js process global
declare const process: {
	env: {
		PWD?: string;
		[key: string]: string | undefined;
	};
	platform: string;
};

function quotePath(filePath: string): string {
	return `"${filePath.replace(/["\\$`]/g, '\\$&')}"`;
}


interface OperationContext {
	env: {
		STORAGE_LOCATIONS?: string | string[];
		[key: string]: string | number | string[] | undefined;
	};
	services: {
		FilesService: new (options: { schema: Record<string, any>; accountability?: any }) => any;
		FoldersService: new (options: { schema: Record<string, any>; accountability?: any }) => any;
		[key: string]: any;
	};
	getSchema: () => Promise<Record<string, any>>;
	logger: {
		info: (message: string, ...args: any[]) => void;
		warn: (message: string, ...args: any[]) => void;
		error: (message: string, ...args: any[]) => void;
		debug: (message: string, ...args: any[]) => void;
	};
}

interface File {
	filename_disk: string;
	storage: string;
	[key: string]: any;
}

interface OperationInput {
	file: File | string;
	folder_id?: string;
	process_mode?: 'all' | 'hls_only' | 'hls_and_audio' | 'move_hls' | 'key_only' | 'audio_only' | 'transcription_only';
	keyBaseUrl?: string;
	playlist_reference_type?: 'id' | 'filename_disk';
	qualities?: string[] | string;
	prevent_upscale?: boolean;
	threads?: number | string;
	nice?: number | string;
	storage_adapter?: 'default' | 'source' | 'r2' | 'custom';
	target_storage?: string;
	key_storage_adapter?: 'directus' | 'target' | 'custom';
	key_target_storage?: string;
	audio_storage_adapter?: 'directus' | 'target' | 'custom';
	audio_target_storage?: string;
	delete_source_file?: boolean;
	delete_existing_hls?: boolean;
	generate_captions?: boolean;
	caption_language?: string;
	caption_endpoint?: string;
	caption_api_key?: string;
	caption_api_type?: 'env' | 'openai' | 'azure';
	generate_speech2text?: boolean;
	speech2text_subscription_key?: string;
	speech2text_endpoint?: string;
	speech2text_locale?: string;
	speech2text_diarization?: boolean;
	speech2text_access_token?: string;
	speech2text_speaker_map?: any;
	speech2text_timeout?: number | string;
	speech2text_poll_interval?: number | string;
}

interface QualityOption {
	id: number;
	options: string;
}

interface VideoMetadata {
	width: number;
	height: number;
	isVertical: boolean;
	duration: number;
}

interface ImageMetadata {
	width: number;
	height: number;
}

interface UploadedFile {
	filename_disk: string;
	id: string;
}

interface OperationResult {
	master: {
		id: string | null;
		filename_disk: string;
	};
	metadata: {
		availableQualities: number[];
		dimensions: {
			width: number;
			height: number;
			isVertical: boolean;
		};
		duration: number;
		thumbnail: string | null;
		subtitle: string | null;
		audio?: string | null;
		s2t_subtitle?: string | null;
		s2t_json?: string | null;
		s2t_error?: string | null;
	};
	files: UploadedFile[];
	error?: string;
}

export default {
	id: 'transcode-video-operation',
	handler: async (
		{
			file,
			folder_id,
			process_mode = 'all',
			keyBaseUrl,
			playlist_reference_type = 'filename_disk',
			qualities = ['240p', '480p', '720p', '1080p', '2160p'],
			prevent_upscale = true,
			threads = 1,
			nice,
			storage_adapter = 'default',
			target_storage,
			key_storage_adapter = 'directus',
			key_target_storage,
			audio_storage_adapter = 'directus',
			audio_target_storage,
			delete_source_file = false,
			delete_existing_hls = false,
			generate_captions = false,
			caption_language,
			caption_endpoint,
			caption_api_key,
			caption_api_type = 'env',
			generate_speech2text = false,
			speech2text_subscription_key,
			speech2text_endpoint,
			speech2text_locale = 'id-ID',
			speech2text_diarization = true,
			speech2text_access_token,
			speech2text_speaker_map,
			speech2text_timeout,
			speech2text_poll_interval
		}: OperationInput,
		{ env, services, getSchema, logger }: OperationContext
	): Promise<OperationResult | { error: string }> => {
		if (!file) {
			logger.info("[transcode-video-operation] Input file missing");
			throw new Error("Input file missing");
		}

		if (!folder_id) {
			logger.info("[transcode-video-operation] folder_id parameter is required");
			throw new Error("folder_id parameter is required");
		}

		// Robust file object resolution: fetch complete record from Directus DB regardless of how file input was passed
		let fileObject: File;
		let targetFileId: string | null = null;

		if (typeof file === 'string') {
			targetFileId = file;
		} else if (file && typeof file === 'object') {
			targetFileId = file.id || (file as any).data?.id || file.key || file.file || null;
		}

		const { FilesService } = services;
		const filesService = new FilesService({
			schema: await getSchema(),
		});

		if (targetFileId) {
			try {
				const fileRecord = await filesService.readOne(targetFileId);
				fileObject = fileRecord as File;
				logger.info(`[transcode-video-operation] Fetched file record from UUID: ${targetFileId}`);
			} catch (error) {
				logger.warn(`[transcode-video-operation] Could not fetch file record with ID ${targetFileId}, falling back to provided input object:`, error);
				fileObject = file as File;
			}
		} else if (file && typeof file === 'object' && file.filename_disk) {
			try {
				const records = await filesService.readByQuery({
					filter: { filename_disk: { _eq: file.filename_disk } },
					limit: 1
				});
				if (records && records.length > 0) {
					fileObject = records[0] as File;
					logger.info(`[transcode-video-operation] Fetched file record by filename_disk: ${file.filename_disk}`);
				} else {
					fileObject = file as File;
				}
			} catch (err) {
				fileObject = file as File;
			}
		} else {
			fileObject = file as File;
		}

		if (!fileObject?.filename_disk) {
			logger.info("[transcode-video-operation] Input file missing filename_disk");
			throw new Error("Input file missing filename_disk");
		}

		// --- EARLY EXIT GUARD: Prevent recursive or unwanted execution on HLS output files or non-media assets ---
		const fnDiskLower = fileObject.filename_disk.toLowerCase();
		const mimeTypeLower = (fileObject.type || '').toLowerCase();

		const isHlsAssetExt = fnDiskLower.endsWith('.ts') || 
			fnDiskLower.endsWith('.key') || 
			fnDiskLower.endsWith('.m3u8') || 
			fnDiskLower.endsWith('.keyinfo') ||
			fnDiskLower.endsWith('.vtt') ||
			fnDiskLower.endsWith('.srt');

		const isHlsAssetPattern = fnDiskLower.includes('_master.m3u8') || 
			fnDiskLower.includes('_thumb.jpg') || 
			fnDiskLower.includes('_thumb.png') || 
			/_\d+p(_\d+)?\.(m3u8|ts)$/i.test(fnDiskLower);

		const isMediaFile = mimeTypeLower.startsWith('video/') || 
			mimeTypeLower.startsWith('audio/') || 
			['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].some(ext => fnDiskLower.endsWith(ext));

		if (isHlsAssetExt || isHlsAssetPattern || !isMediaFile) {
			logger.info(`[transcode-video-operation] (${fileObject.filename_disk}) Skipping file: File is an HLS segment/asset or non-primary media file.`);
			return {
				skipped: true,
				reason: `File ${fileObject.filename_disk} is an HLS asset or non-primary media file.`
			};
		}

		const lastDotIndex = fileObject.filename_disk.lastIndexOf('.');
		let filename: string;
		let extension: string;

		if (lastDotIndex > 0) {
			const possibleExt = fileObject.filename_disk.substring(lastDotIndex + 1);
			if (possibleExt.includes(' ') || possibleExt.includes('/') || possibleExt.length > 10) {
				filename = fileObject.filename_disk;
				extension = '';
			} else {
				filename = fileObject.filename_disk.substring(0, lastDotIndex);
				extension = possibleExt;
			}
		} else {
			filename = fileObject.filename_disk;
			extension = '';
		}

		// Resolve baseUrl early for both downloading source files and constructing S2T callback URLs
		const getHostPort = (): string => {
			const host = env.HOST && typeof env.HOST === 'string' && env.HOST.trim() !== ''
				? (env.HOST.trim() === '0.0.0.0' ? 'localhost' : env.HOST.trim())
				: 'localhost';
			const port = env.PORT && typeof env.PORT === 'string' && env.PORT.trim() !== ''
				? env.PORT.trim()
				: (env.PORT && typeof env.PORT === 'number' ? String(env.PORT) : '8055');
			return `http://${host}:${port}`;
		};

		let baseUrl: string;
		const publicUrlRaw = env.PUBLIC_URL;
		if (publicUrlRaw && typeof publicUrlRaw === 'string') {
			const trimmed = publicUrlRaw.trim();
			if (trimmed === '' || trimmed === '/') {
				baseUrl = getHostPort();
			} else {
				baseUrl = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
			}
		} else {
			baseUrl = getHostPort();
		}

		// Get available storage locations from environment (STORAGE_LOCATIONS can be CSV string or array)
		const storageLocations = env.STORAGE_LOCATIONS
			? Array.isArray(env.STORAGE_LOCATIONS)
				? env.STORAGE_LOCATIONS.map(loc => String(loc).trim())
				: String(env.STORAGE_LOCATIONS).split(',').map(loc => loc.trim())
			: [];
		const defaultStorageAdapter = storageLocations.length > 0 ? storageLocations[0] : "local";

		// Helper function to validate if a storage location exists in Directus
		const validateStorageExists = (location: string): boolean => {
			const locLower = location.toLowerCase();
			if (locLower === 'local') return true;

			// Check if location is in STORAGE_LOCATIONS list if STORAGE_LOCATIONS is defined
			const inLocationsList = storageLocations.length === 0 || 
				storageLocations.some(loc => loc.toLowerCase() === locLower);

			const driverKey = `STORAGE_${location.toUpperCase()}_DRIVER`;
			const hasDriver = !!env[driverKey];

			return inLocationsList && hasDriver;
		};

		// Helper functions for storage resolution (needed early for output directory determination)
		const resolveStorage = (location: string): string | null => {
			const envKey = `STORAGE_${location.toUpperCase()}_ROOT`;
			const envValue = env[envKey];

			if (envValue) {
				return String(envValue);
			} else {
				const driverKey = `STORAGE_${location.toUpperCase()}_DRIVER`;
				const driver = env[driverKey];
				if (!driver || driver === 'local') {
					logger.warn(`[transcode-video-operation] (${filename}) No storage root found for local storage location <%s>`, location);
				}
				return null;
			}
		}

		const getStorageDriver = (location: string): string | null => {
			const envKey = `STORAGE_${location.toUpperCase()}_DRIVER`;
			const envValue = env[envKey];

			if (envValue) {
				return String(envValue);
			} else {
				// Default to 'local' if driver not specified (backward compatibility)
				logger.warn(`[transcode-video-operation] (${filename}) No driver found for storage location <%s>, assuming 'local'`, location);
				return 'local';
			}
		}

		// Determine target storage adapter based on user selection
		let targetStorageAdapter: string;
		if (storage_adapter === 'source') {
			// Use the same storage as the source file
			targetStorageAdapter = fileObject.storage || defaultStorageAdapter;
			if (!validateStorageExists(targetStorageAdapter)) {
				const errorMsg = `Source storage location "${targetStorageAdapter}" does not exist in Directus configuration. Please ensure "${targetStorageAdapter}" is added to STORAGE_LOCATIONS in your Directus .env file. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
		} else if (storage_adapter === 'r2') {
			// Explicitly target Cloudflare R2 storage
			const r2Location = storageLocations.find(loc => 
				loc.toLowerCase() === 'r2' || 
				loc.toLowerCase() === 'cloudflare' ||
				loc.toLowerCase().includes('r2')
			) || 'r2';

			if (!validateStorageExists(r2Location)) {
				const errorMsg = `Storage location "${r2Location}" does not exist in Directus configuration. Location "${r2Location}" must be added to STORAGE_LOCATIONS in your Directus .env file (e.g. STORAGE_LOCATIONS="local,${r2Location}") AND STORAGE_${r2Location.toUpperCase()}_DRIVER must be configured. Available configured locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
			targetStorageAdapter = r2Location;
			logger.info(`[transcode-video-operation] (${filename}) Using Cloudflare R2 storage location: ${targetStorageAdapter}`);
		} else if (storage_adapter === 'custom' && target_storage) {
			// Validate that the custom storage location exists
			if (!validateStorageExists(target_storage)) {
				const errorMsg = `Custom storage location "${target_storage}" does not exist in Directus configuration. Please ensure "${target_storage}" is added to STORAGE_LOCATIONS in your Directus .env file and STORAGE_${target_storage.toUpperCase()}_DRIVER is configured. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
			targetStorageAdapter = target_storage;
			logger.info(`[transcode-video-operation] (${filename}) Using custom storage location: ${target_storage}`);
		} else {
			// Use environment default (first configured storage location)
			targetStorageAdapter = defaultStorageAdapter;
			if (!validateStorageExists(targetStorageAdapter)) {
				const errorMsg = `Default storage location "${targetStorageAdapter}" does not exist in Directus configuration. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
		}

		logger.info(`[transcode-video-operation] (${filename}) Using storage adapter for HLS files: ${targetStorageAdapter}`);

		// Determine key storage adapter
		let keyStorageAdapter: string;
		if (key_storage_adapter === 'target') {
			keyStorageAdapter = targetStorageAdapter;
		} else if (key_storage_adapter === 'custom' && key_target_storage) {
			if (!validateStorageExists(key_target_storage)) {
				const errorMsg = `Custom key storage location "${key_target_storage}" does not exist in Directus configuration. Please ensure "${key_target_storage}" is added to STORAGE_LOCATIONS in your Directus .env file and STORAGE_${key_target_storage.toUpperCase()}_DRIVER is configured. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
			keyStorageAdapter = key_target_storage;
			logger.info(`[transcode-video-operation] (${filename}) Using custom key storage location: ${key_target_storage}`);
		} else {
			// Default / 'directus': Save Key in Directus default storage (first configured storage location or local)
			keyStorageAdapter = defaultStorageAdapter;
			if (!validateStorageExists(keyStorageAdapter)) {
				const errorMsg = `Default key storage location "${keyStorageAdapter}" is not valid in Directus. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
		}

		logger.info(`[transcode-video-operation] (${filename}) Using key storage adapter: ${keyStorageAdapter}`);

		if (keyStorageAdapter !== targetStorageAdapter && !keyBaseUrl) {
			logger.warn(`[transcode-video-operation] (${filename}) NOTICE: Key storage (${keyStorageAdapter}) differs from target HLS storage (${targetStorageAdapter}). HLS players reading playlists from ${targetStorageAdapter} will look for the .key file on ${targetStorageAdapter}. Set "Key Storage Adapter" to "Same as HLS Target Storage" (target) OR configure "Key Base URL" to your Directus assets domain so players can find the key!`);
		}

		// Determine target storage driver early (used for output directory and cleanup)
		const targetStorageDriver = getStorageDriver(targetStorageAdapter);
		const isLocalTarget = targetStorageDriver === 'local';

		// outputDir will be set later based on the target storage location
		let outputDir: string;

		// Function to generate optimized quality options for raw exec commands
		const getQualityOptionsRaw = (isHighBitDepth = false, keyInfoPath?: string): QualityOption[] => {
			// Always use main profile for maximum compatibility
			const profile = 'main';

			// Force output pixel format to yuv420p to guarantee compatibility with iOS/AVPlayer
			const pixelFormat = 'format=yuv420p,';

			// Tone-mapping and color space override to force standard BT.709 SDR on iOS (AVPlayer fails on BT.2020 / HDR 10-bit H.264 profiles)
			const colorSpaceFlags = '-pix_fmt yuv420p -colorspace bt709 -color_trc bt709 -color_primaries bt709 -level:v 4.1';

			// Add encryption options if keyInfoPath is provided
			const encryptionOptions = keyInfoPath ? `-hls_key_info_file ${quotePath(keyInfoPath)}` : '';

			return [
				{
					id: 240,
					options: `-vf "${pixelFormat}scale=w='min(426,iw)':h='min(240,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 22 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 400k -maxrate 428k -bufsize 600k -b:a 64k ${encryptionOptions} -hls_segment_filename ${quotePath(`${outputDir}/${filename}_240p_%03d.ts`)} ${quotePath(`${outputDir}/${filename}_240p.m3u8`)}`
				},
				{
					id: 480,
					options: `-vf "${pixelFormat}scale=w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 1400k -maxrate 1498k -bufsize 2100k -b:a 128k ${encryptionOptions} -hls_segment_filename ${quotePath(`${outputDir}/${filename}_480p_%03d.ts`)} ${quotePath(`${outputDir}/${filename}_480p.m3u8`)}`
				},
				{
					id: 720,
					options: `-vf "${pixelFormat}scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 2800k -maxrate 2996k -bufsize 4200k -b:a 128k ${encryptionOptions} -hls_segment_filename ${quotePath(`${outputDir}/${filename}_720p_%03d.ts`)} ${quotePath(`${outputDir}/${filename}_720p.m3u8`)}`
				},
				{
					id: 1080,
					options: `-vf "${pixelFormat}scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 5000k -maxrate 5350k -bufsize 7500k -b:a 192k ${encryptionOptions} -hls_segment_filename ${quotePath(`${outputDir}/${filename}_1080p_%03d.ts`)} ${quotePath(`${outputDir}/${filename}_1080p.m3u8`)}`
				},
				{
					id: 2160,
					options: `-vf "${pixelFormat}scale=w='min(3840,iw)':h='min(2160,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 20000k -maxrate 21400k -bufsize 30000k -b:a 192k ${encryptionOptions} -hls_segment_filename ${quotePath(`${outputDir}/${filename}_2160p_%03d.ts`)} ${quotePath(`${outputDir}/${filename}_2160p.m3u8`)}`
				}
			];
		};
		const hlsFolderId = folder_id;

		const readFiles = (linkFilePath: string): string[] => {
			const data = fs.readdirSync(linkFilePath, 'utf-8').filter(fn => 
				(fn.startsWith(`${filename}_`) || fn === `${filename}.m3u8` || fn === `${filename}.key`) && 
				fn !== fileObject.filename_disk && 
				fn !== fileObject.filename_download
			);
			return data;
		}

		// Get video/audio metadata (dimensions, duration)
		const getVideoMetadata = async (inputFile: string): Promise<VideoMetadata> => {
			return new Promise((resolve, reject) => {
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json ${quotePath(inputFile)}`,
					(error, stdout) => {
						if (error) {
							// Try to query just format duration as fallback (for audio inputs)
							exec(`ffprobe -v error -show_entries format=duration -of json ${quotePath(inputFile)}`, (err2, stdout2) => {
								if (err2) {
									logger.error(`[transcode-video-operation] (${filename}) Error getting metadata:`, err2);
									reject(err2);
									return;
								}
								try {
									const data2 = JSON.parse(stdout2);
									const duration = data2.format?.duration ? Math.floor(parseFloat(data2.format.duration) * 1000) : 0;
									resolve({ width: 0, height: 0, isVertical: false, duration });
								} catch (parseError) {
									reject(parseError);
								}
							});
							return;
						}

						try {
							const data = JSON.parse(stdout);
							const stream = data.streams?.[0];
							const format = data.format;

							if (!stream || !stream.width || !stream.height) {
								// Fallback for audio files
								const duration = format?.duration ? Math.floor(parseFloat(format.duration) * 1000) : 0;
								resolve({ width: 0, height: 0, isVertical: false, duration });
								return;
							}

							const width = parseInt(stream.width);
							const height = parseInt(stream.height);
							const duration = format?.duration ? Math.floor(parseFloat(format.duration) * 1000) : 0;
							const isVertical = height > width;

							resolve({ width, height, isVertical, duration });
						} catch (parseError) {
							logger.error(`[transcode-video-operation] (${filename}) Error parsing metadata:`, parseError);
							reject(parseError);
						}
					});
			});
		};

		// Extract thumbnail at 1 second
		const extractThumbnail = async (inputFile: string, outputPath: string): Promise<string> => {
			return new Promise((resolve, reject) => {
				exec(`ffmpeg -loglevel warning -y -i ${quotePath(inputFile)} -ss 1 -vframes 1 -q:v 2 ${quotePath(outputPath)}`, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
					if (error) {
						logger.error(`[transcode-video-operation] (${filename}) Error extracting thumbnail:`, error);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(error);
						return;
					}

					// Verify the thumbnail file was actually created and has content
					if (!fs.existsSync(outputPath)) {
						const errorMsg = `Thumbnail file was not created: ${outputPath}`;
						logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(new Error(errorMsg));
						return;
					}

					const fileSize = fs.statSync(outputPath).size;
					if (fileSize === 0) {
						const errorMsg = `Thumbnail file is empty: ${outputPath}`;
						logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(new Error(errorMsg));
						return;
					}

					resolve(outputPath);
				});
			});
		};

		// Get image metadata (dimensions)
		const getImageMetadata = async (imagePath: string): Promise<ImageMetadata> => {
			return new Promise((resolve, reject) => {
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${quotePath(imagePath)}`,
					(error, stdout) => {
						if (error) {
							logger.error(`[transcode-video-operation] (${filename}) Error getting image metadata:`, error);
							reject(error);
							return;
						}

						try {
							const data = JSON.parse(stdout);
							const stream = data.streams?.[0];

							if (!stream || !stream.width || !stream.height) {
								reject(new Error('Could not get image dimensions'));
								return;
							}

							const width = parseInt(stream.width);
							const height = parseInt(stream.height);

							resolve({ width, height });
						} catch (parseError) {
							logger.error(`[transcode-video-operation] (${filename}) Error parsing image metadata:`, parseError);
							reject(parseError);
						}
					});
			});
		};

		// Create folder in Directus if it doesn't exist
		const ensureFolder = async (folderName: string, parentFolderId: string | null = null): Promise<string> => {
			try {
				const { FoldersService } = services;
				const foldersService = new FoldersService({
					schema: await getSchema(),
				});

				// Build filter to find existing folder
				const filter: any = { name: { _eq: folderName } };
				if (parentFolderId) {
					filter.parent = { _eq: parentFolderId };
				}

				// Try to find existing folder
				const existingFolders = await foldersService.readByQuery({
					filter: filter
				});

				if (existingFolders && Array.isArray(existingFolders) && existingFolders.length > 0) {
					const folderId = existingFolders[0]?.id || existingFolders[0]?.data?.id || existingFolders[0];
					logger.info(`[transcode-video-operation] (${filename}) Found existing folder: ${folderId}`);
					return String(folderId);
				}

				// Create new folder
				const folderData: any = { name: folderName };
				if (parentFolderId) {
					folderData.parent = parentFolderId;
					logger.info(`[transcode-video-operation] (${filename}) Creating folder "${folderName}" with parent ${parentFolderId}`);
				} else {
					logger.info(`[transcode-video-operation] (${filename}) Creating folder "${folderName}" at root`);
				}

				const newFolder = await foldersService.createOne(folderData);

				// Try different possible response structures
				const folderId = newFolder?.id || newFolder?.data?.id || (typeof newFolder === 'string' ? newFolder : null);

				if (!folderId) {
					throw new Error(`Failed to get folder ID from response: ${JSON.stringify(newFolder)}`);
				}

				logger.info(`[transcode-video-operation] (${filename}) Created folder with ID: ${folderId}`);
				return String(folderId);
			} catch (error) {
				logger.error(`[transcode-video-operation] (${filename}) Error creating folder:`, error);
				throw error;
			}
		};

		// Create file record in Directus and upload to storage
		// For local storage: file is already on disk, FilesService just creates the DB record
		// For cloud storage (S3, GCS, etc.): FilesService automatically uploads the file stream to the configured storage adapter
		const uploadFileToDirectus = async (
			filePath: string,
			folderId: string | null = null,
			options: { mimetype?: string; width?: number | null; height?: number | null; storage?: string } = {}
		): Promise<string> => {
			try {
				const { FilesService } = services;
				const filesService = new FilesService({
					schema: await getSchema(),
				});

				const fileName = path.basename(filePath);
				const extension = fileName.substr(fileName.lastIndexOf('.') + 1);

				// Verify file exists before attempting upload
				if (!fs.existsSync(filePath)) {
					throw new Error(`File does not exist: ${filePath}`);
				}

				const fileSizeInBytes = fs.statSync(filePath).size;
				const storage = options.storage || targetStorageAdapter;
				const fileStorageDriver = getStorageDriver(storage);
				const isFileLocalStorage = fileStorageDriver === 'local';

				// Only log for cloud storage uploads, not for local storage registration
				if (!isFileLocalStorage) {
					logger.info(`[transcode-video-operation] (${filename}) Uploading file: ${fileName} (${fileSizeInBytes} bytes) to storage: ${storage}`);
				}

				const types: Record<string, string> = {
					ts: "video/mp2t",
					mp4: "video/mp4",
					jpeg: "image/jpeg",
					jpg: "image/jpeg",
					m3u8: "application/x-mpegurl"
				};

				const mimetype = options.mimetype || types[extension] || 'application/octet-stream';

				// Check if file already exists in Directus
				const filter: any = {
					filename_disk: { _eq: fileName },
					storage: { _eq: storage }
				};
				if (folderId) {
					filter.folder = { _eq: folderId };
				} else {
					filter.folder = { _null: true };
				}

				const existingFiles = await filesService.readByQuery({
					filter: filter,
					limit: 1
				});

				if (existingFiles && Array.isArray(existingFiles) && existingFiles.length > 0) {
					const existingFile = existingFiles[0];
					const existingFileId = existingFile?.id || existingFile?.data?.id || (typeof existingFile === 'string' ? existingFile : null);
					if (existingFileId) {
						logger.info(`[transcode-video-operation] (${filename}) File already exists in Directus: ${fileName} (ID: ${existingFileId}), reusing`);
						return String(existingFileId);
					}
				}

				// Prepare file data
				const fileData: any = {
					storage: storage,
					filename_disk: fileName,
					filename_download: fileName,
					title: fileName,
					type: mimetype,
					filesize: fileSizeInBytes
				};

				// Add width and height if provided
				if (options.width !== undefined && options.width !== null) {
					fileData.width = options.width;
				}
				if (options.height !== undefined && options.height !== null) {
					fileData.height = options.height;
				}

				// Add folder if provided
				if (folderId) {
					fileData.folder = folderId;
				}

				let fileId: string;
				try {
					const fileStorageDriver = getStorageDriver(storage);
					const isFileLocalStorage = fileStorageDriver === 'local';
					const storagePath = isFileLocalStorage ? resolveStorage(storage) : null;
					const basePath = process.env.PWD || '/directus';
					const storageFullPath = storagePath ? path.join(basePath, storagePath) : null;
					const isFileInStorageDir = storageFullPath && filePath.startsWith(storageFullPath);

					if (isFileLocalStorage && isFileInStorageDir) {
						// For local storage where file is already in the target storage directory:
						// Just create the database record using createOne()
						fileId = await filesService.createOne(fileData);
					} else {
						// For cloud storage OR local storage when file is in a temp directory:
						// Use uploadOne() to upload/write the file stream to the configured storage driver
						const fileStream = fs.createReadStream(filePath);

						// Handle stream errors
						fileStream.on('error', (streamError) => {
							logger.error(`[transcode-video-operation] (${filename}) File stream error for ${fileName}:`, streamError);
						});

						fileId = await filesService.uploadOne(
							fileStream,
							fileData
						);
					}

					// Verify which storage was actually used by reading the file record back
					try {
						const uploadedFileRecord = await filesService.readOne(fileId);
						const actualStorage = (uploadedFileRecord as any)?.storage || (uploadedFileRecord as any)?.data?.storage;
						if (actualStorage !== storage) {
							logger.warn(`[transcode-video-operation] (${filename}) Storage mismatch! Requested ${storage} but file was stored in ${actualStorage}`);
						}
					} catch (verifyError) {
						// Silently ignore verification errors
					}

					// Don't log individual file uploads to reduce log noise (especially for many segment files)
					// Summary is logged at the end with total file count
				} catch (uploadError) {
					const actionVerb = isFileLocalStorage ? 'registering' : 'uploading';
					logger.error(`[transcode-video-operation] (${filename}) Error ${actionVerb} file ${fileName}:`, uploadError);
					throw uploadError;
				}

				// uploadOne() returns the file ID directly (PrimaryKey type)
				if (!fileId || (typeof fileId !== 'string' && typeof fileId !== 'number')) {
					logger.error(`[transcode-video-operation] (${filename}) Invalid file ID returned from uploadOne: ${fileId}`);
					throw new Error(`Failed to get file ID from uploadOne. Returned: ${fileId}`);
				}

				return String(fileId);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				logger.error(`[transcode-video-operation] (${filename}) Error creating file record for ${filePath}: ${errorMessage}`);
				if (errorMessage.includes("doesn't exist") || errorMessage.includes("Location")) {
					logger.error(`[transcode-video-operation] (${filename}) DIRECTUS STORAGE DIAGNOSTIC: Directus rejected storage location "${options.storage || targetStorageAdapter}".`);
					logger.error(`[transcode-video-operation] (${filename}) Common causes: 1) Directus server was not restarted after updating .env (Directus loads STORAGE_LOCATIONS only on boot). 2) Missing STORAGE_R2_S3_FORCE_PATH_STYLE="true" for Cloudflare R2. 3) STORAGE_R2_KEY is invalid or using a User API Token (cfat_...) instead of an R2 S3 Access Key ID (32-hex string).`);
				}
				if (errorStack) {
					logger.error(`[transcode-video-operation] (${filename}) Error stack: ${errorStack}`);
				}
				throw error;
			}
		};

		// Parse m3u8 file and replace filenames with file IDs or filename_disk
		const rebuildPlaylist = (playlistPath: string, fileIdMap: Record<string, string>, useFilenameDisk = false, logger?: any): string => {
			// Verify file exists and has content
			if (!fs.existsSync(playlistPath)) {
				throw new Error(`Playlist file does not exist: ${playlistPath}`);
			}
			const fileSize = fs.statSync(playlistPath).size;
			if (fileSize === 0) {
				throw new Error(`Playlist file is empty: ${playlistPath}`);
			}

			let content = fs.readFileSync(playlistPath, 'utf-8');
			if (!content || content.trim().length === 0) {
				throw new Error(`Playlist file content is empty: ${playlistPath}`);
			}

			const lines = content.split('\n');
			const newLines: string[] = [];

			// UUID pattern: 8-4-4-4-12 hexadecimal characters
			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

			for (const line of lines) {
				if (line.startsWith('#EXT-X-KEY:')) {
					// Handle encryption key tag: #EXT-X-KEY:METHOD=AES-128,URI="filename.key",IV=0x...
					let newLine = line;
					const uriMatch = line.match(/URI="([^"]+)"/);
					if (uriMatch && uriMatch[1]) {
						const originalKeyURI = uriMatch[1];
						const keyBasename = path.basename(originalKeyURI);

						const keyId = fileIdMap[originalKeyURI] || fileIdMap[keyBasename];

						if (keyBaseUrl) {
							// If keyBaseUrl is explicitly configured:
							const formattedKeyBaseUrl = keyBaseUrl.endsWith('/') ? keyBaseUrl.slice(0, -1) : keyBaseUrl;
							const keyRef = useFilenameDisk ? keyBasename : (keyId || keyBasename);
							newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${formattedKeyBaseUrl}/${keyRef}"`);
						} else if (keyId) {
							// Check if key is stored in a different location than HLS files (e.g. key on Directus, HLS on Cloudflare R2)
							const isKeyOnDifferentStorage = keyStorageAdapter !== targetStorageAdapter;
							if (isKeyOnDifferentStorage) {
								// When key is on Directus while HLS files are hosted on Cloudflare R2 / cloud,
								// player fetching playlist from Cloudflare needs absolute Directus asset URL to fetch key from Directus!
								newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${baseUrl}/assets/${keyId}"`);
							} else if (!useFilenameDisk) {
								newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${keyId}"`);
							}
						}
					}
					newLines.push(newLine);
				} else if (line.startsWith('#') || line.trim() === '') {
					// Keep other comments and empty lines as-is
					newLines.push(line);
				} else {
					// Replace filename with file ID or filename_disk (relative path, no /assets/ prefix)
					let filename = line.trim();
					// Strip /assets/ prefix if present
					if (filename.startsWith('/assets/')) {
						filename = filename.substring('/assets/'.length);
					}
					// Ensure filename is trimmed (remove any trailing whitespace)
					filename = filename.trim();

					// If the line is already a UUID (file ID) and we're using file IDs, keep it as-is
					if (uuidPattern.test(filename) && !useFilenameDisk) {
						newLines.push(filename);
						continue;
					}

					// Also try with just the basename in case path is included
					const basename = path.basename(filename);
					// Try multiple lookup strategies: exact match, basename match, and trimmed versions
					const fileId = fileIdMap[filename] || fileIdMap[basename] || fileIdMap[filename.trim()] || fileIdMap[basename.trim()];

					if (fileId) {
						if (useFilenameDisk) {
							// Use filename_disk (the original filename) - compatible with CDN / Cloudflare R2
							newLines.push(basename);
						} else {
							// Use file ID (UUID) - Directus internal /assets/ reference
							newLines.push(fileId);
						}
					} else {
						// File ID not found in map - this should not happen if files were uploaded correctly
						// Log a warning but keep the original filename as fallback
						// This might happen if fileIdMap wasn't populated correctly
						if (!useFilenameDisk) {
							// Only warn if we're trying to use file IDs (not filename_disk)
							// This indicates a problem with fileIdMap population
							const availableKeys = Object.keys(fileIdMap).slice(0, 10).join(', ');
							const exactMatch = fileIdMap.hasOwnProperty(filename);
							const basenameMatch = fileIdMap.hasOwnProperty(basename);
							if (logger) {
								logger.warn(`[transcode-video-operation] File ID not found in map for: "${filename}" (basename: "${basename}"). Exact match: ${exactMatch}, Basename match: ${basenameMatch}. Available keys (first 10): ${availableKeys}...`);
							}
						}
						// Keep original if not found (might be from previous run with different file IDs)
						newLines.push(line);
					}
				}
			}

			return newLines.join('\n');
		};

		function checkFFmpegAvailable(): Promise<void> {
			return new Promise((resolve, reject) => {
				exec('which ffmpeg', (error, stdout, stderr) => {
					if (error || !stdout.trim()) {
						reject(new Error('FFmpeg is not installed or not found in PATH. Please install ffmpeg.'));
						return;
					}
					resolve();
				});
			});
		}

		function ffmpegRawSync(inputFile: string, quality: QualityOption, validatedThreads: number, niceValue?: number): Promise<string> {
			return new Promise((resolve, reject) => {
				// Build command with optional nice prefix (only on Unix-like systems: Linux, macOS, etc.)
				// Windows doesn't have 'nice' command, so we skip it on Windows
				const isWindows = process.platform === 'win32';
				const nicePrefix = (!isWindows && niceValue !== undefined && niceValue !== null) ? `nice -n ${niceValue} ` : '';
				if (isWindows && niceValue !== undefined && niceValue !== null) {
					logger.warn(`[transcode-video-operation] (${filename}) Nice value (${niceValue}) specified but running on Windows - nice command not available, ignoring priority setting`);
				}
				const command = `${nicePrefix}ffmpeg -loglevel warning -y -i ${quotePath(inputFile)} -threads ${validatedThreads} ${quality.options}`;
				exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
					if (error) {
						logger.error(`[transcode-video-operation] (${filename}) Error occured for quality: %s`, quality.id);
						logger.error(error.message);
						logger.error(`stdout: ${stdout}`);
						logger.error(`stderr: ${stderr}`);
						reject(new Error(`FFmpeg transcoding failed for quality ${quality.id}p: ${error.message}. stderr: ${stderr}`));
						return;
					}

					// Check stderr for common error messages even if exec didn't report an error
					if (stderr && (stderr.includes('not found') || stderr.includes('command not found'))) {
						logger.error(`[transcode-video-operation] (${filename}) FFmpeg not found in stderr for quality: %s`, quality.id);
						logger.error(`stderr: ${stderr}`);
						reject(new Error(`FFmpeg command not found. stderr: ${stderr}`));
						return;
					}

					// Verify that the playlist file was actually created and has content
					const expectedPlaylistPath = `${outputDir}/${filename}_${quality.id}p.m3u8`;
					if (!fs.existsSync(expectedPlaylistPath)) {
						const errorMsg = `Playlist file was not created: ${expectedPlaylistPath}`;
						logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(new Error(errorMsg));
						return;
					}

					const playlistSize = fs.statSync(expectedPlaylistPath).size;
					if (playlistSize === 0) {
						const errorMsg = `Playlist file is empty: ${expectedPlaylistPath}`;
						logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(new Error(errorMsg));
						return;
					}

					// Verify playlist has valid content (at least contains #EXTM3U)
					const playlistContent = fs.readFileSync(expectedPlaylistPath, 'utf-8');
					if (!playlistContent.includes('#EXTM3U')) {
						const errorMsg = `Playlist file does not contain valid HLS content: ${expectedPlaylistPath}`;
						logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(new Error(errorMsg));
						return;
					}

					logger.info(`[transcode-video-operation] (${filename}) Transcoding finished for quality: %s`, quality.id);
					resolve(stdout.trim());
				})
			})
		}

		const extractAudio = async (inputFile: string, outputPath: string, forceMono: boolean, niceValue?: number): Promise<string> => {
			return new Promise((resolve, reject) => {
				logger.info(`[transcode-video-operation] (${filename}) Extracting audio track to: ${outputPath} (Force mono: ${forceMono})`);

				const isWindows = process.platform === 'win32';
				const nicePrefix = (!isWindows && niceValue !== undefined && niceValue !== null) ? `nice -n ${niceValue} ` : '';

				const audioParams = forceMono ? '-ac 1 -ar 16000' : '';
				const command = `${nicePrefix}ffmpeg -loglevel warning -y -i ${quotePath(inputFile)} -vn -acodec libmp3lame ${audioParams} -q:a 4 ${quotePath(outputPath)}`;

				exec(command, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
					if (error) {
						logger.error(`[transcode-video-operation] (${filename}) Error extracting audio track:`, error);
						if (stderr) {
							logger.error(`[transcode-video-operation] (${filename}) FFmpeg stderr: ${stderr}`);
						}
						reject(error);
						return;
					}

					if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
						reject(new Error("Extracted audio file is missing or empty"));
						return;
					}

					logger.info(`[transcode-video-operation] (${filename}) Audio track extracted successfully`);
					resolve(outputPath);
				});
			});
		};

		const transcribeAudio = async (audioPath: string): Promise<string> => {
			const apiEndpoint = caption_endpoint || (env.TRANSCRIBE_API_ENDPOINT as string);
			const apiKey = caption_api_key || (env.TRANSCRIBE_API_KEY as string);
			let apiType = caption_api_type === 'env' ? (env.TRANSCRIBE_API_TYPE as string) : caption_api_type;

			if (!apiType || apiType === 'env') {
				apiType = 'openai';
			}

			if (!apiEndpoint) {
				throw new Error("API Endpoint for transcription is not configured. Please set TRANSCRIBE_API_ENDPOINT in .env or supply a Flow override.");
			}
			if (!apiKey) {
				throw new Error("API Key for transcription is not configured. Please set TRANSCRIBE_API_KEY in .env or supply a Flow override.");
			}

			logger.info(`[transcode-video-operation] (${filename}) Transcribing audio using endpoint: ${apiEndpoint} (Type: ${apiType})`);

			const audioData = fs.readFileSync(audioPath);
			const audioBlob = new Blob([audioData], { type: 'audio/mpeg' });

			const formData = new FormData();
			formData.append('file', audioBlob, path.basename(audioPath));
			formData.append('model', 'whisper');
			formData.append('response_format', 'vtt');

			if (caption_language) {
				formData.append('language', caption_language);
			}

			const headers: Record<string, string> = {};
			if (apiType === 'azure') {
				headers['api-key'] = apiKey;
			} else {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}

			const response = await fetch(apiEndpoint, {
				method: 'POST',
				headers,
				body: formData
			});

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Whisper API transcription failed (HTTP ${response.status}): ${errText}`);
			}

			const vttResult = await response.text();
			if (!vttResult || vttResult.trim().length === 0) {
				throw new Error("Transcription returned empty response");
			}

			return vttResult;
		};

		const convertAzureJsonToSrt = (jsonData: any, speakerMap: any): string => {
			let srt = "";
			let index = 1;
			const phrases = jsonData.recognizedPhrases || [];

			let parsedMap: Record<string, string> = {};
			if (speakerMap) {
				if (typeof speakerMap === 'string') {
					try {
						parsedMap = JSON.parse(speakerMap);
					} catch (e) {
						logger.warn(`[transcode-video-operation] Failed to parse speaker map: ${e instanceof Error ? e.message : String(e)}`);
					}
				} else if (typeof speakerMap === 'object') {
					parsedMap = speakerMap;
				}
			}

			const parseOffset = (offsetStr: string | undefined, offsetInTicks: number | undefined): number => {
				if (offsetInTicks !== undefined && offsetInTicks !== null) {
					return offsetInTicks / 10000;
				}
				if (!offsetStr) return 0;
				const match = offsetStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
				if (!match) return 0;
				const hours = parseFloat(match[1] || '0');
				const minutes = parseFloat(match[2] || '0');
				const seconds = parseFloat(match[3] || '0');
				return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
			};

			const formatSrtTime = (ms: number): string => {
				const hours = Math.floor(ms / 3600000);
				const minutes = Math.floor((ms % 3600000) / 60000);
				const seconds = Math.floor((ms % 60000) / 1000);
				const milliseconds = Math.floor(ms % 1000);
				const pad = (num: number, size: number) => String(num).padStart(size, '0');
				return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`;
			};

			const wrapText = (text: string, maxLen = 60): string => {
				if (!text) return '';
				const words = text.split(' ');
				const lines: string[] = [];
				let currentLine = '';

				for (const word of words) {
					if (!word) continue;
					if (currentLine.length + word.length + 1 <= maxLen) {
						if (currentLine.length > 0) {
							currentLine += ' ' + word;
						} else {
							currentLine = word;
						}
					} else {
						if (currentLine.length > 0) {
							lines.push(currentLine);
						}
						currentLine = word;
					}
				}
				if (currentLine.length > 0) {
					lines.push(currentLine);
				}
				return lines.join('\n');
			};

			for (const phrase of phrases) {
				const startMs = parseOffset(phrase.offset, phrase.offsetInTicks);
				const durationMs = parseOffset(phrase.duration, phrase.durationInTicks);
				const endMs = startMs + durationMs;

				const startTimeStr = formatSrtTime(startMs);
				const endTimeStr = formatSrtTime(endMs);

				const display = phrase.nBest?.[0]?.display || "";
				const speaker = phrase.speaker;

				let speakerPrefix = "";
				if (speaker !== undefined) {
					const speakerName = (parsedMap && parsedMap[String(speaker)]) || `Speaker ${speaker}`;
					speakerPrefix = `[${speakerName}] `;
				}

				const combinedText = `${speakerPrefix}${display}`.trim();
				const wrappedText = wrapText(combinedText, 60);

				if (wrappedText) {
					srt += `${index}\n${startTimeStr} --> ${endTimeStr}\n${wrappedText}\n\n`;
					index++;
				}
			}

			return srt;
		};

		/* Start of the script */
		logger.info(`[transcode-video-operation] (${filename}) Operation started`);

		// Ensure threads is a number (may come as string from form input)
		// 0 means use all available cores, 1+ means use that many threads
		const threadCount = threads !== undefined && threads !== null ? parseInt(String(threads), 10) : 1;
		const validatedThreads = (isNaN(threadCount) || threadCount < 0) ? 1 : threadCount;

		// Validate nice value (may come as string from form input)
		// Nice values range from 0 (default priority) to 19 (lowest priority)
		// If not provided or invalid, undefined means don't use nice
		let validatedNice: number | undefined = undefined;
		if (nice !== undefined && nice !== null) {
			const niceNum = parseInt(String(nice), 10);
			if (!isNaN(niceNum) && niceNum >= 0 && niceNum <= 19) {
				validatedNice = niceNum;
			} else {
				logger.warn(`[transcode-video-operation] (${filename}) Invalid nice value: ${nice}. Must be between 0 and 19. Ignoring.`);
			}
		}

		// Helper function to safely stream source file from Directus (via FilesService stream or AssetsService or HTTP with auth)
		const downloadSourceFileStream = async (fileId: string, destPath: string): Promise<void> => {
			// 1. Try FilesService.getStream(fileId) directly
			try {
				const { FilesService } = services;
				const fsService = new FilesService({ schema: await getSchema(), accountability });
				if (typeof (fsService as any).getStream === 'function') {
					const readStream = await (fsService as any).getStream(fileId);
					const writeStream = fs.createWriteStream(destPath);
					await new Promise<void>((resolve, reject) => {
						readStream.pipe(writeStream);
						writeStream.on('finish', () => { writeStream.close(); resolve(); });
						writeStream.on('error', reject);
						readStream.on('error', reject);
					});
					logger.info(`[transcode-video-operation] (${filename}) Source stream retrieved via FilesService.getStream`);
					return;
				}
			} catch (err) {
				logger.warn(`[transcode-video-operation] (${filename}) FilesService.getStream failed, trying AssetsService fallback:`, err instanceof Error ? err.message : String(err));
			}

			// 2. Try AssetsService.getAsset(fileId)
			try {
				const { AssetsService } = services;
				const assetsService = new AssetsService({ schema: await getSchema(), accountability });
				const asset = await assetsService.getAsset(fileId, {});
				if (asset && asset.stream) {
					const writeStream = fs.createWriteStream(destPath);
					await new Promise<void>((resolve, reject) => {
						asset.stream.pipe(writeStream);
						writeStream.on('finish', () => { writeStream.close(); resolve(); });
						writeStream.on('error', reject);
						asset.stream.on('error', reject);
					});
					logger.info(`[transcode-video-operation] (${filename}) Source stream retrieved via AssetsService.getAsset`);
					return;
				}
			} catch (err) {
				logger.warn(`[transcode-video-operation] (${filename}) AssetsService.getAsset failed, trying authenticated HTTP request:`, err instanceof Error ? err.message : String(err));
			}

			// 3. Fallback to HTTP download with Authorization token header
			const assetUrl = `${baseUrl}/assets/${fileId}`;
			const headers: Record<string, string> = {};
			if (accountability && (accountability as any).token) {
				headers['Authorization'] = `Bearer ${(accountability as any).token}`;
			}

			logger.info(`[transcode-video-operation] (${filename}) Downloading source file via HTTP from ${assetUrl}...`);

			await new Promise<void>((resolve, reject) => {
				try {
					new URL(assetUrl);
				} catch (urlError) {
					reject(new Error(`Invalid asset URL: ${assetUrl}`));
					return;
				}

				const protocol = assetUrl.startsWith('https') ? https : http;
				const parsedUrl = new URL(assetUrl);
				const reqOpts = {
					protocol: parsedUrl.protocol,
					hostname: parsedUrl.hostname,
					port: parsedUrl.port,
					path: parsedUrl.pathname + parsedUrl.search,
					headers: headers
				};

				const request = protocol.get(reqOpts, (response: any) => {
					if (response.statusCode !== 200) {
						reject(new Error(`Failed to download file: HTTP ${response.statusCode}`));
						return;
					}
					const writeStream = fs.createWriteStream(destPath);
					response.pipe(writeStream);
					writeStream.on('finish', () => { writeStream.close(); resolve(); });
					writeStream.on('error', reject);
				});
				request.on('error', reject);
			});
		};

		// Handle source file location: ALWAYS copy or download to an isolated temporary workspace directory!
		// This guarantees that any DB purge or external deletion of local uploads will NEVER touch or destroy our active source file!
		let filePath: string = '';
		let tempSourceFile: string | null = null;
		let needsCleanup = false;

		const sourceStorageDriver = getStorageDriver(fileObject.storage);
		const isLocalSource = sourceStorageDriver === 'local';

		// Get file ID from fileObject
		let fileId: string | null = null;
		if (typeof file === 'string') {
			fileId = file;
		} else if (fileObject.id) {
			fileId = String(fileObject.id);
		} else if ((fileObject as any).data?.id) {
			fileId = String((fileObject as any).data.id);
		}

		// Create temporary workspace directory for source file isolation
		const tempDir = path.join(process.env.PWD || '/directus', 'tmp', 'transcode');
		if (!fs.existsSync(tempDir)) {
			try {
				fs.mkdirSync(tempDir, { recursive: true, mode: 0o755 });
			} catch (mkdirErr) {
				logger.warn(`[transcode-video-operation] (${filename}) Could not create tempDir ${tempDir}:`, mkdirErr);
			}
		}

		const isolatedSourcePath = path.join(tempDir, `source_${Date.now()}_${fileId || filename}.${extension || 'mp4'}`);

		let sourcePrepared = false;

		if (isLocalSource) {
			const storagePath = resolveStorage(fileObject.storage);
			if (storagePath) {
				const basePath = process.env.PWD || '/directus';
				const candidatePath = path.join(basePath, `${storagePath}/${fileObject.filename_disk}`);
				if (fs.existsSync(candidatePath)) {
					try {
						// Copy physical local file to isolated workspace
						fs.copyFileSync(candidatePath, isolatedSourcePath);
						filePath = isolatedSourcePath;
						tempSourceFile = isolatedSourcePath;
						needsCleanup = true;
						sourcePrepared = true;
						logger.info(`[transcode-video-operation] (${filename}) Copied local source file to isolated temporary workspace: ${isolatedSourcePath}`);
					} catch (copyErr) {
						logger.warn(`[transcode-video-operation] (${filename}) Failed to copy local file to isolated workspace, using candidate path:`, copyErr);
						filePath = candidatePath;
						sourcePrepared = true;
					}
				}
			}
		}

		if (!sourcePrepared && fileId) {
			try {
				logger.info(`[transcode-video-operation] (${filename}) Fetching source file stream to isolated temporary workspace: ${isolatedSourcePath}`);
				await downloadSourceFileStream(fileId, isolatedSourcePath);
				filePath = isolatedSourcePath;
				tempSourceFile = isolatedSourcePath;
				needsCleanup = true;
				sourcePrepared = true;
				logger.info(`[transcode-video-operation] (${filename}) Source file stream fetched successfully to: ${filePath}`);
			} catch (dlErr) {
				const errorMessage = dlErr instanceof Error ? dlErr.message : String(dlErr);
				logger.error(`[transcode-video-operation] (${filename}) Error fetching source file: ${errorMessage}`);
				return {
					error: `Failed to fetch source file: ${errorMessage}`
				};
			}
		}

		// Determine output directory based on target storage adapter
		// For local storage: files must be in the target storage location
		// For cloud storage: can use temp directory, files will be uploaded
		if (isLocalTarget) {
			// For local storage, output files must be in the target storage location
			const targetStoragePath = resolveStorage(targetStorageAdapter);
			if (!targetStoragePath) {
				return {
					error: `No storage found for target location <${targetStorageAdapter}>`
				};
			}
			const basePath = process.env.PWD || '/directus';
			// Use the same subdirectory structure as the source file (if it exists)
			const sourceDir = path.dirname(filePath);
			const sourceStoragePath = resolveStorage(fileObject.storage);
			let relativePath = '';
			if (sourceStoragePath) {
				const sourceStorageFullPath = path.join(basePath, sourceStoragePath);
				if (sourceDir.startsWith(sourceStorageFullPath)) {
					// Extract relative path from source storage root
					relativePath = path.relative(sourceStorageFullPath, sourceDir);
				}
			}
			// If no relative path, just use the target storage root
			outputDir = relativePath
				? path.join(basePath, targetStoragePath, relativePath)
				: path.join(basePath, targetStoragePath);
			logger.info(`[transcode-video-operation] (${filename}) Target storage is local (${targetStorageAdapter}), output directory: ${outputDir}`);
		} else {
			// For cloud storage, create a dedicated isolated temporary workspace directory so local uploads directory is NEVER polluted or touched!
			const basePath = process.env.PWD || '/directus';
			outputDir = path.join(basePath, 'tmp', 'transcode', `${filename}_${Date.now()}`);
			logger.info(`[transcode-video-operation] (${filename}) Target storage is cloud (${targetStorageAdapter}), isolated output directory: ${outputDir}`);
		}

		logger.info(`[transcode-video-operation] (${filename}) File to be transcoded: %s`, filePath)
		logger.info(`[transcode-video-operation] (${filename}) Output directory: %s`, outputDir)

		// Ensure the output directory exists
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
			logger.info(`[transcode-video-operation] (${filename}) Folder created`)
		}

		// Check if ffmpeg is available before starting any transcoding
		try {
			await checkFFmpegAvailable();
			logger.info(`[transcode-video-operation] (${filename}) FFmpeg is available`);
		} catch (error) {
			logger.info(`[transcode-video-operation] (${filename}) FFmpeg check failed: %s`, error instanceof Error ? error.message : String(error));
			throw error;
		}

		const isAudioInput = fileObject.type?.startsWith('audio/') || extension?.toLowerCase() === 'mp3';

		// Get video/audio metadata early to determine source resolution/duration and prevent upscaling
		logger.info(`[transcode-video-operation] (${filename}) Getting source metadata...`);
		const sourceMetadata = await getVideoMetadata(filePath).catch(error => {
			logger.error(`[transcode-video-operation] (${filename}) Error getting source metadata:`, error);
			// If we can't get metadata, allow all qualities (fallback behavior)
			return { width: 99999, height: 99999, isVertical: false, duration: 0 };
		});

		const metadata = sourceMetadata;
		const sourceHeight = sourceMetadata.height;
		logger.info(`[transcode-video-operation] (${filename}) Source metadata: width=${sourceMetadata.width}, height=${sourceHeight}, duration=${sourceMetadata.duration}`);

		// Create virtual folder for this file's transcoded assets
		// Use folder_id as parent and filename as the folder name
		logger.info(`[transcode-video-operation] (${filename}) Creating virtual folder...`);
		const targetFolderId = await ensureFolder(filename, folder_id);
		logger.info(`[transcode-video-operation] (${filename}) Created/using folder: ${targetFolderId}`);

		// --- HLS AES-128 Encryption Support ---
		let keyInfoPath: string | undefined = undefined;
		const keyFilename = `${filename}.key`;
		const keyFileLocalPath = path.join(outputDir, keyFilename);

		let masterId: string | null = null;
		let thumbnailId: string | null = null;
		const fileIdMap: Record<string, string> = {};
		const uploadedFiles: UploadedFile[] = [];
		let qualitiesRaw: any[] = [];

		if (process_mode === 'key_only') {
			logger.info(`[transcode-video-operation] (${filename}) Running in key_only mode. Syncing/registering .key file...`);

			// Ensure local key path exists or create a 16-byte key if missing
			if (!fs.existsSync(keyFileLocalPath)) {
				const keyStorageRoot = resolveStorage(keyStorageAdapter);
				const basePath = process.env.PWD || '/directus';
				const localKeyRootPath = keyStorageRoot ? path.join(basePath, keyStorageRoot, keyFilename) : null;

				if (localKeyRootPath && fs.existsSync(localKeyRootPath)) {
					fs.mkdirSync(path.dirname(keyFileLocalPath), { recursive: true });
					fs.copyFileSync(localKeyRootPath, keyFileLocalPath);
					logger.info(`[transcode-video-operation] (${filename}) Found existing key in local storage root: ${localKeyRootPath}`);
				} else {
					const encryptionKey = crypto.randomBytes(16);
					fs.mkdirSync(path.dirname(keyFileLocalPath), { recursive: true });
					fs.writeFileSync(keyFileLocalPath, encryptionKey);
					logger.info(`[transcode-video-operation] (${filename}) Generated new 16-byte HLS encryption key: ${keyFileLocalPath}`);
				}
			}

			if (fs.existsSync(keyFileLocalPath)) {
				let keyUploadPath = keyFileLocalPath;
				const keyStorageDriver = getStorageDriver(keyStorageAdapter);

				if (keyStorageDriver === 'local') {
					const keyStorageRoot = resolveStorage(keyStorageAdapter);
					if (keyStorageRoot) {
						const basePath = process.env.PWD || '/directus';
						const targetKeyStorageDir = path.join(basePath, keyStorageRoot);
						if (!fs.existsSync(targetKeyStorageDir)) {
							try {
								fs.mkdirSync(targetKeyStorageDir, { recursive: true, mode: 0o755 });
							} catch (dirErr) {}
						}
						const targetKeyPath = path.join(targetKeyStorageDir, keyFilename);
						try {
							fs.copyFileSync(keyFileLocalPath, targetKeyPath);
							keyUploadPath = targetKeyPath;
						} catch (copyKeyErr) {}
					}
				}

				const keyId = await uploadFileToDirectus(keyUploadPath, targetFolderId, {
					mimetype: 'application/octet-stream',
					storage: keyStorageAdapter
				});
				fileIdMap[keyFilename] = keyId;
				uploadedFiles.push({ filename_disk: keyFilename, id: keyId });
				logger.info(`[transcode-video-operation] (${filename}) key_only mode completed! Key File ID: ${keyId}`);
			}

			return {
				master: null,
				metadata: {
					availableQualities: null,
					dimensions: null,
					duration: 0,
					thumbnail: null,
					subtitle: null,
					audio: null,
					s2t_json: null,
					s2t_subtitle: null,
					s2t_error: null
				},
				files: uploadedFiles
			};
		}

		if (process_mode === 'move_hls') {
			logger.info(`[transcode-video-operation] (${filename}) Running in move_hls mode. Moving local HLS files to target storage (${targetStorageAdapter})...`);

			const basePath = process.env.PWD || '/directus';
			const { FilesService } = services;
			const filesService = new FilesService({ schema: await getSchema() });

			const existingFileRecords = await filesService.readByQuery({
				filter: {
					_or: [
						{ filename_disk: { _starts_with: `${filename}_` } },
						{ filename_disk: { _eq: `${filename}.m3u8` } },
						{ filename_disk: { _eq: `${filename}.key` } }
					]
				},
				limit: -1
			});

			if (!existingFileRecords || existingFileRecords.length === 0) {
				logger.warn(`[transcode-video-operation] (${filename}) No existing HLS files found in database for video ${filename}`);
				return {
					error: `No existing HLS files found for video ${filename}`
				};
			}

			const keyRecord = existingFileRecords.find((f: any) => f.filename_disk === keyFilename);
			let keyId: string | null = keyRecord?.id || null;

			const isKeyStorageLocal = getStorageDriver(keyStorageAdapter) === 'local';
			if (isKeyStorageLocal && !keyId) {
				const keyStorageRoot = resolveStorage(keyStorageAdapter);
				const localKeyRootPath = keyStorageRoot ? path.join(basePath, keyStorageRoot, keyFilename) : null;

				if (localKeyRootPath && fs.existsSync(localKeyRootPath)) {
					try {
						keyId = await uploadFileToDirectus(localKeyRootPath, targetFolderId, {
							mimetype: 'application/octet-stream',
							storage: keyStorageAdapter
						});
					} catch (kErr) {}
				}
			}

			let movedCount = 0;

			// 1. Move all non-playlist files (.ts segments) to targetStorageAdapter
			for (const rec of existingFileRecords) {
				const recName = rec.filename_disk as string;
				if (!recName) continue;

				// ALWAYS preserve .key files — never move, never delete
				if (recName.endsWith('.key')) {
					logger.info(`[transcode-video-operation] (${filename}) Preserving key file ${recName} in local key storage (${keyStorageAdapter})`);
					fileIdMap[recName] = rec.id;
					uploadedFiles.push({ filename_disk: recName, id: rec.id });
					continue;
				}

				// Skip playlists — handled separately below
				if (recName.endsWith('.m3u8')) {
					continue;
				}

				// Only move .ts segment files — skip .mp4, .jpg, .mp3, etc.
				if (!recName.endsWith('.ts')) {
					logger.info(`[transcode-video-operation] (${filename}) Skipping non-segment file: ${recName}`);
					fileIdMap[recName] = rec.id;
					uploadedFiles.push({ filename_disk: recName, id: rec.id });
					continue;
				}

				if (rec.storage !== targetStorageAdapter) {
					try {
						const recStoragePath = resolveStorage(rec.storage) || 'uploads';
						const localCandidatePath = path.join(basePath, recStoragePath, recName);

						// ALWAYS copy the file to temp FIRST before any DB deletion,
						// because filesService.deleteOne() deletes both the DB record AND the physical file!
						const tempSegmentPath = path.join(outputDir, recName);
						fs.mkdirSync(path.dirname(tempSegmentPath), { recursive: true });

						if (fs.existsSync(localCandidatePath)) {
							// Copy local file to temp directory
							fs.copyFileSync(localCandidatePath, tempSegmentPath);
						} else {
							// File not on disk, try to stream from Directus storage
							let stream: any;
							try {
								if (typeof (filesService as any).getStream === 'function') {
									stream = await (filesService as any).getStream(rec.id);
								} else {
									const { AssetsService } = services;
									const assetsService = new AssetsService({ schema: await getSchema() });
									const asset = await assetsService.getAsset(rec.id, {});
									stream = asset?.stream;
								}
							} catch (sErr) {}

							if (!stream) {
								throw new Error(`Could not obtain stream for file ${recName} (ID: ${rec.id})`);
							}

							const writeStream = fs.createWriteStream(tempSegmentPath);
							await new Promise<void>((resStream, rejStream) => {
								stream.pipe(writeStream);
								writeStream.on('finish', () => { writeStream.close(); resStream(); });
								writeStream.on('error', rejStream);
								stream.on('error', rejStream);
							});
						}

						// Now delete old DB record (this also deletes the physical local file, but we have our temp copy)
						try { await filesService.deleteOne(rec.id); } catch (e) {}

						// Upload from temp copy to target storage (R2)
						const newId = await uploadFileToDirectus(tempSegmentPath, targetFolderId, {
							mimetype: rec.type || (recName.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream'),
							storage: targetStorageAdapter
						});

						fileIdMap[recName] = newId;
						uploadedFiles.push({ filename_disk: recName, id: newId });

						// Clean up temp file
						try { fs.unlinkSync(tempSegmentPath); } catch (e) {}

						movedCount++;
						logger.info(`[transcode-video-operation] (${filename}) Successfully moved ${recName} to target storage ${targetStorageAdapter}`);
					} catch (moveErr) {
						const moveErrMsg = moveErr instanceof Error ? moveErr.stack || moveErr.message : String(moveErr);
						logger.error(`[transcode-video-operation] (${filename}) Error moving file ${recName}: ${moveErrMsg}`);
					}
				} else {
					fileIdMap[recName] = rec.id;
					uploadedFiles.push({ filename_disk: recName, id: rec.id });
				}
			}

			// 2. Rebuild and upload playlists (.m3u8) to targetStorageAdapter
			const playlistRecords = existingFileRecords.filter((rec: any) => rec.filename_disk?.endsWith('.m3u8'));

			for (const plRec of playlistRecords) {
				const plName = plRec.filename_disk as string;
				try {
					let playlistContent = '';
					const recStoragePath = resolveStorage(plRec.storage) || 'uploads';
					const localPlPath = path.join(basePath, recStoragePath, plName);

					if (fs.existsSync(localPlPath)) {
						playlistContent = fs.readFileSync(localPlPath, 'utf-8');
					} else {
						let plStream: any;
						try {
							if (typeof (filesService as any).getStream === 'function') {
								plStream = await (filesService as any).getStream(plRec.id);
							} else {
								const { AssetsService } = services;
								const assetsService = new AssetsService({ schema: await getSchema() });
								const asset = await assetsService.getAsset(plRec.id, {});
								plStream = asset?.stream;
							}
						} catch (psErr) {}

						if (plStream) {
							const chunks: Buffer[] = [];
							await new Promise<void>((resPl, rejPl) => {
								plStream.on('data', (chunk: Buffer) => chunks.push(chunk));
								plStream.on('end', () => { playlistContent = Buffer.concat(chunks).toString('utf-8'); resPl(); });
								plStream.on('error', rejPl);
							});
						}
					}

					if (!playlistContent) {
						logger.warn(`[transcode-video-operation] (${filename}) Could not read playlist content for ${plName}`);
						continue;
					}

					const lines = playlistContent.split(/\r?\n/);
					const newLines: string[] = [];

					for (const line of lines) {
						let newLine = line;
						if (line.startsWith('#EXT-X-KEY:')) {
							const uriMatch = line.match(/URI="([^"]+)"/);
							if (uriMatch && uriMatch[1]) {
								const originalKeyURI = uriMatch[1];
								const keyBasename = path.basename(originalKeyURI);
								const currentKeyId = fileIdMap[originalKeyURI] || fileIdMap[keyBasename] || keyId;

								if (keyBaseUrl) {
									const formattedKeyBaseUrl = keyBaseUrl.endsWith('/') ? keyBaseUrl.slice(0, -1) : keyBaseUrl;
									const keyRef = useFilenameDisk ? keyBasename : (currentKeyId || keyBasename);
									newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${formattedKeyBaseUrl}/${keyRef}"`);
								} else if (isKeyStorageLocal && currentKeyId) {
									newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${baseUrl}/assets/${currentKeyId}"`);
								} else {
									newLine = line.replace(`URI="${originalKeyURI}"`, `URI="${keyBasename}"`);
								}
							}
						}
						newLines.push(newLine);
					}

					const tempPlPath = path.join(outputDir, plName);
					fs.mkdirSync(path.dirname(tempPlPath), { recursive: true });
					fs.writeFileSync(tempPlPath, newLines.join('\n'));

					// Delete old playlist record from directus_files DB BEFORE uploadOne to avoid filename_disk collision
					try { await filesService.deleteOne(plRec.id); } catch (e) {}

					const newPlId = await uploadFileToDirectus(tempPlPath, targetFolderId, {
						mimetype: 'application/x-mpegurl',
						storage: targetStorageAdapter
					});

					fileIdMap[plName] = newPlId;
					uploadedFiles.push({ filename_disk: plName, id: newPlId });

					if (fs.existsSync(localPlPath)) {
						try { fs.unlinkSync(localPlPath); } catch (e) {}
					}
					try { fs.unlinkSync(tempPlPath); } catch (e) {}
					movedCount++;
					logger.info(`[transcode-video-operation] (${filename}) Rebuilt and uploaded playlist ${plName} to ${targetStorageAdapter}`);
				} catch (plErr) {
					const plErrMsg = plErr instanceof Error ? plErr.stack || plErr.message : String(plErr);
					logger.error(`[transcode-video-operation] (${filename}) Error processing playlist ${plName}: ${plErrMsg}`);
				}
			}

			if (fs.existsSync(outputDir)) {
				try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) {}
			}

			logger.info(`[transcode-video-operation] (${filename}) move_hls completed! Successfully processed ${movedCount} HLS files to storage: ${targetStorageAdapter}`);

			const masterRecord = playlistRecords.find((r: any) => r.filename_disk?.endsWith('_master.m3u8') || r.filename_disk === `${filename}.m3u8`);
			const masterFileId = masterRecord ? (fileIdMap[masterRecord.filename_disk] || masterRecord.id) : null;

			return {
				master: masterFileId ? { id: masterFileId, filename_disk: masterRecord ? masterRecord.filename_disk : `${filename}_master.m3u8` } : null,
				metadata: {
					availableQualities: null,
					dimensions: null,
					duration: 0,
					thumbnail: null,
					subtitle: null,
					audio: null,
					s2t_json: null,
					s2t_subtitle: null,
					s2t_error: null
				},
				files: uploadedFiles
			};
		}

		if (process_mode === 'all' || process_mode === 'hls_only' || process_mode === 'hls_and_audio') {
			if (delete_existing_hls) {
				logger.info(`[transcode-video-operation] (${filename}) delete_existing_hls is enabled. Purging all existing HLS files from Directus database and storage...`);
				try {
					const { FilesService } = services;
					const filesService = new FilesService({
						schema: await getSchema(),
					});

					// Find existing HLS files matching this video's transcode outputs (excluding the source input file)
					const sourceFileId = fileObject.id || (fileObject as any).data?.id || targetFileId || (typeof file === 'string' ? file : null);
					const sourceFileNameDisk = fileObject.filename_disk;
					const sourceFileNameDownload = fileObject.filename_download;

					const filterConditions: any[] = [
						{
							_or: [
								{ filename_disk: { _starts_with: `${filename}_` } },
								{ filename_disk: { _eq: `${filename}.key` } },
								{ filename_disk: { _eq: `${filename}.m3u8` } },
								{
									_and: [
										{ folder: { _eq: targetFolderId } },
										{
											_or: [
												{ filename_disk: { _ends_with: '.ts' } },
												{ filename_disk: { _ends_with: '.m3u8' } },
												{ filename_disk: { _ends_with: '.key' } }
											]
										}
									]
								}
							]
						}
					];

					if (sourceFileId) {
						filterConditions.push({ id: { _neq: String(sourceFileId) } });
					}
					if (sourceFileNameDisk) {
						filterConditions.push({ filename_disk: { _neq: sourceFileNameDisk } });
					}

					const filter: any = {
						_and: filterConditions
					};

					const existingFilesToDelete = await filesService.readByQuery({
						filter: filter,
						fields: ['*'],
						limit: -1
					});

					if (existingFilesToDelete && Array.isArray(existingFilesToDelete) && existingFilesToDelete.length > 0) {
						logger.info(`[transcode-video-operation] (${filename}) Found ${existingFilesToDelete.length} potential HLS file record(s) to inspect`);
						
						const idsToDelete: string[] = [];
						const mediaExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

						for (const fileRecordRaw of existingFilesToDelete) {
							let fileRecord = fileRecordRaw;
							const fileIdToDelete = fileRecord?.id || fileRecord?.data?.id || (typeof fileRecord === 'string' ? fileRecord : null);
							if (!fileIdToDelete) continue;

							// If filename_disk is missing from the record, read the full record to be 100% sure!
							if (!fileRecord?.filename_disk && typeof fileIdToDelete === 'string') {
								try {
									fileRecord = await filesService.readOne(fileIdToDelete);
								} catch (readErr) {
									logger.warn(`[transcode-video-operation] (${filename}) Could not read file record ${fileIdToDelete} for safety inspection, skipping deletion.`);
									continue;
								}
							}

							const fnDisk = (fileRecord?.filename_disk || '').toString().toLowerCase();
							const fnDownload = (fileRecord?.filename_download || '').toString().toLowerCase();
							const fileIdStr = String(fileIdToDelete).toLowerCase();
							const srcIdStr = sourceFileId ? String(sourceFileId).toLowerCase() : '';
							const srcFnDiskStr = sourceFileNameDisk ? String(sourceFileNameDisk).toLowerCase() : '';
							const srcFnDlStr = sourceFileNameDownload ? String(sourceFileNameDownload).toLowerCase() : '';
							const fullFilenameExt = `${filename}.${extension}`.toLowerCase();

							// Strict checks: Is this a source file or primary media file?
							const isSourceIdMatch = !!(srcIdStr && fileIdStr === srcIdStr);
							const isSourceDiskMatch = !!(srcFnDiskStr && fnDisk === srcFnDiskStr);
							const isSourceDlMatch = !!(srcFnDlStr && fnDisk === srcFnDlStr);
							const isSourceFullMatch = fnDisk === fullFilenameExt;
							const isMediaExtMatch = mediaExtensions.some(ext => fnDisk.endsWith(ext) || fnDownload.endsWith(ext));
							const isHlsExtension = fnDisk.endsWith('.ts') || fnDisk.endsWith('.m3u8') || fnDisk.endsWith('.key') || fnDisk.endsWith('.keyinfo') || fnDisk.endsWith('_thumb.jpg') || fnDisk.endsWith('_thumb.png');

							if (isSourceIdMatch || isSourceDiskMatch || isSourceDlMatch || isSourceFullMatch || isMediaExtMatch || !isHlsExtension) {
								logger.warn(`[transcode-video-operation] (${filename}) ABSOLUTE SAFETY PREVENTED DELETION of non-HLS/source file: fnDisk="${fileRecord?.filename_disk}", id="${fileIdToDelete}"`);
								continue;
							}

							idsToDelete.push(String(fileIdToDelete));
						}

						if (idsToDelete.length > 0) {
							logger.info(`[transcode-video-operation] (${filename}) Confirmed ${idsToDelete.length} verified HLS file record(s) to delete in batch...`);
							const batchSize = 100;
							for (let i = 0; i < idsToDelete.length; i += batchSize) {
								const batch = idsToDelete.slice(i, i + batchSize);
								try {
									await filesService.deleteMany(batch);
									logger.info(`[transcode-video-operation] (${filename}) Deleted batch of ${batch.length} existing HLS file record(s) (${Math.min(i + batchSize, idsToDelete.length)}/${idsToDelete.length})`);
								} catch (batchErr) {
									logger.warn(`[transcode-video-operation] (${filename}) Error deleting batch of HLS files, falling back to individual deletion for this batch:`, batchErr);
									for (const singleId of batch) {
										try {
											await filesService.deleteOne(singleId);
											logger.info(`[transcode-video-operation] (${filename}) Deleted existing HLS file: ${singleId}`);
										} catch (delError) {
											logger.warn(`[transcode-video-operation] (${filename}) Could not delete existing HLS file record ${singleId}:`, delError);
										}
									}
								}
							}
						} else {
							logger.info(`[transcode-video-operation] (${filename}) No valid HLS file records found after safety filtering.`);
						}
					} else {
						logger.info(`[transcode-video-operation] (${filename}) No existing HLS file records found in Directus to delete`);
					}
				} catch (purgeError) {
					logger.error(`[transcode-video-operation] (${filename}) Error during deletion of existing HLS file records:`, purgeError);
				}

				// Also clean up any local disk HLS files in outputDir matching this video (excluding original source file)
				if (fs.existsSync(outputDir)) {
					try {
						const mediaExts = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
						const localFiles = fs.readdirSync(outputDir).filter(fn => {
							const fnLower = fn.toLowerCase();
							const isMediaExt = mediaExts.some(ext => fnLower.endsWith(ext));
							if (isMediaExt) return false;

							const isHlsExt = fnLower.endsWith('.ts') || fnLower.endsWith('.m3u8') || fnLower.endsWith('.key') || fnLower.endsWith('.keyinfo') || fnLower.endsWith('_thumb.jpg') || fnLower.endsWith('_thumb.png');
							if (!isHlsExt) return false;

							return (fnLower.startsWith(`${filename.toLowerCase()}_`) || fnLower === `${filename.toLowerCase()}.m3u8` || fnLower === `${filename.toLowerCase()}.key`) && 
								fnLower !== fileObject.filename_disk.toLowerCase() && 
								fnLower !== (fileObject.filename_download || '').toLowerCase() &&
								fnLower !== `${filename.toLowerCase()}.${extension.toLowerCase()}`;
						});
						for (const fn of localFiles) {
							const localPath = path.join(outputDir, fn);
							try {
								if (fs.existsSync(localPath)) {
									fs.unlinkSync(localPath);
									logger.info(`[transcode-video-operation] (${filename}) Deleted old local HLS file on disk: ${fn}`);
								}
							} catch (unlinkErr) {
								logger.warn(`[transcode-video-operation] (${filename}) Could not delete old local file ${fn}:`, unlinkErr);
							}
						}
					} catch (readdirErr) {
						logger.warn(`[transcode-video-operation] (${filename}) Error reading local directory for cleanup:`, readdirErr);
					}
				}
			}

			// --- AUTOMATIC RE-FETCH GUARD: Verify source file is physically present on disk before ffprobe/ffmpeg ---
			if (!filePath || !fs.existsSync(filePath)) {
				logger.warn(`[transcode-video-operation] (${filename}) Source file missing on disk (${filePath}), re-downloading via Directus assets API...`);
				try {
					let fileId: string | null = null;
					if (typeof file === 'string') {
						fileId = file;
					} else if (fileObject.id) {
						fileId = String(fileObject.id);
					} else if ((fileObject as any).data?.id) {
						fileId = String((fileObject as any).data.id);
					}

					if (fileId) {
						const tempDir = path.join(process.env.PWD || '/directus', 'tmp', 'transcode');
						if (!fs.existsSync(tempDir)) {
							fs.mkdirSync(tempDir, { recursive: true, mode: 0o755 });
						}
						const tempFilePath = path.join(tempDir, `${fileId}_${fileObject.filename_disk}`);
						const assetUrl = `${baseUrl}/assets/${fileId}`;

						logger.info(`[transcode-video-operation] (${filename}) Re-downloading source file from ${assetUrl} to ${tempFilePath}...`);

						await new Promise<void>((resolve, reject) => {
							const protocol = assetUrl.startsWith('https') ? https : http;
							const request = protocol.get(assetUrl, (response) => {
								if (response.statusCode !== 200) {
									reject(new Error(`Failed to download file: HTTP ${response.statusCode}`));
									return;
								}
								const writeStream = fs.createWriteStream(tempFilePath);
								response.pipe(writeStream);
								writeStream.on('finish', () => {
									writeStream.close();
									resolve();
								});
								writeStream.on('error', reject);
							});
							request.on('error', reject);
						});

						filePath = tempFilePath;
						tempSourceFile = tempFilePath;
						needsCleanup = true;
						logger.info(`[transcode-video-operation] (${filename}) Source file re-downloaded successfully to: ${filePath}`);
					}
				} catch (reDownloadErr) {
					logger.error(`[transcode-video-operation] (${filename}) Error re-downloading source file:`, reDownloadErr);
				}
			}

			let encryptionKey: Buffer;
			if (fs.existsSync(keyFileLocalPath)) {
				// Load the existing key to avoid breaking existing encrypted segments!
				encryptionKey = fs.readFileSync(keyFileLocalPath);
				logger.info(`[transcode-video-operation] (${filename}) Existing HLS encryption key loaded from disk: ${keyFileLocalPath}`);
			} else {
				// Generate a new encryption key
				encryptionKey = crypto.randomBytes(16);
				// Save the raw key directly to the output directory
				fs.writeFileSync(keyFileLocalPath, encryptionKey);
				logger.info(`[transcode-video-operation] (${filename}) HLS encryption key generated: ${keyFileLocalPath}`);
			}

			// Determine keyURI for the manifest
			const keyURI = keyBaseUrl ? `${keyBaseUrl.endsWith('/') ? keyBaseUrl.slice(0, -1) : keyBaseUrl}/${keyFilename}` : keyFilename;

			// Create temporary .keyinfo file
			keyInfoPath = path.join(os.tmpdir(), `${filename}_${crypto.randomBytes(4).toString('hex')}.keyinfo`);
			const keyInfoContent = `${keyURI}\n${keyFileLocalPath}`;
			fs.writeFileSync(keyInfoPath, keyInfoContent);
			logger.info(`[transcode-video-operation] (${filename}) HLS keyinfo file created: ${keyInfoPath}`);
			// --------------------------------------

			// Check if input is 10-bit by examining the video stream
			const isHighBitDepth = await new Promise<boolean>((resolve, reject) => {
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of json ${quotePath(filePath)}`,
					(error, stdout) => {
						if (error) {
							logger.warn(`[transcode-video-operation] (${filename}) Error checking bit depth, assuming 8-bit: %s`, error.message);
							resolve(false); // Default to false if check fails
							return;
						}
						try {
							const data = JSON.parse(stdout);
							const pixFmt = data.streams?.[0]?.pix_fmt;
							// Check if pixel format indicates 10-bit (e.g., yuv420p10le)
							resolve(pixFmt?.includes('10') || false);
						} catch (parseError) {
							logger.warn(`[transcode-video-operation] (${filename}) Error parsing bit depth check, assuming 8-bit`);
							resolve(false);
						}
					});
			});

			if (isHighBitDepth) {
				logger.info(`[transcode-video-operation] (${filename}) High bit depth detected, will convert to yuv420p`);
			}

			// Get optimized quality options with encryption
			const allQualitiesRaw = getQualityOptionsRaw(isHighBitDepth, keyInfoPath);

			// Filter qualities based on user selection (default: all)
			// Handle cases where qualities might be undefined, null, or not an array
			// Tags interface returns strings with "p" suffix (e.g., "240p"), so default is also strings with "p"
			let selectedQualities: string[] = ['240p', '480p', '720p', '1080p', '2160p']; // Default: all qualities
			if (qualities) {
				if (Array.isArray(qualities)) {
					selectedQualities = qualities;
				} else if (typeof qualities === 'string') {
					// Try to parse as JSON if it's a string
					try {
						selectedQualities = JSON.parse(qualities);
					} catch (e) {
						logger.warn(`[transcode-video-operation] (${filename}) Could not parse qualities, using all:`, e);
					}
				}
			}

			// Convert to numbers (tags interface returns strings)
			// Strip "p" suffix if present (e.g., "240p" -> 240)
			const selectedQualitiesNumbers = selectedQualities
				.map(q => {
					if (typeof q === 'string') {
						// Remove "p" suffix if present
						const cleaned = q.replace(/p$/i, '');
						return parseInt(cleaned, 10);
					}
					return q;
				})
				.filter(q => !isNaN(q));

			// Map quality IDs to their target heights
			const qualityHeights: Record<number, number> = {
				240: 240,
				480: 480,
				720: 720,
				1080: 1080,
				2160: 2160
			};

			// Filter qualities: first by user selection, then by source resolution (prevent upscaling)
			qualitiesRaw = allQualitiesRaw.filter(quality => selectedQualitiesNumbers.includes(quality.id));

			// Filter out qualities that would require upscaling if prevent_upscale is enabled
			if (prevent_upscale) {
				const qualitiesBeforeFilter = qualitiesRaw.length;
				qualitiesRaw = qualitiesRaw.filter(quality => {
					const targetHeight = qualityHeights[quality.id];
					if (targetHeight && targetHeight > sourceHeight) {
						logger.info(`[transcode-video-operation] (${filename}) Skipping ${quality.id}p (target: ${targetHeight}px, source: ${sourceHeight}px) to prevent upscaling`);
						return false;
					}
					return true;
				});

				if (qualitiesBeforeFilter > qualitiesRaw.length) {
					logger.info(`[transcode-video-operation] (${filename}) Filtered out ${qualitiesBeforeFilter - qualitiesRaw.length} quality level(s) that would require upscaling (source height: ${sourceHeight}px)`);
				}
			} else {
				logger.info(`[transcode-video-operation] (${filename}) prevent_upscale is disabled. Transcoding all selected qualities regardless of source height (${sourceHeight}px).`);
			}

			logger.info(`[transcode-video-operation] (${filename}) Selected qualities: ${selectedQualitiesNumbers.join(', ')}`);
			logger.info(`[transcode-video-operation] (${filename}) Will transcode ${qualitiesRaw.length} quality levels`);

			if (qualitiesRaw.length === 0) {
				return {
					error: 'No quality levels selected for transcoding'
				};
			}

			// Check if all expected quality playlists already exist and are not empty
			const hasFiles = qualitiesRaw.every(quality => {
				const qualityFile = `${outputDir}/${filename}_${quality.id}p.m3u8`;
				return fs.existsSync(qualityFile) && fs.statSync(qualityFile).size > 0;
			});

			if (!hasFiles) {
				logger.info(`[transcode-video-operation] (${filename}) No existing files found, starting transcoding...`);

				try {
					// Process qualities sequentially to catch errors on the first quality level
					for (const quality of qualitiesRaw) {
						try {
							logger.info(`[transcode-video-operation] (${filename}) Starting transcoding for quality: %sp`, quality.id);
							await ffmpegRawSync(filePath, quality, validatedThreads, validatedNice);
							logger.info(`[transcode-video-operation] (${filename}) Successfully transcoded quality: %sp`, quality.id);
						} catch (error) {
							logger.error(`[transcode-video-operation] (${filename}) Failed to transcode quality %sp:`, quality.id, error);
							throw error; // Re-throw to abort the operation
						}
					}
					logger.info(`[transcode-video-operation] (${filename}) All qualities transcoded successfully`);
				} finally {
					// Clean up temporary .keyinfo file
					if (keyInfoPath && fs.existsSync(keyInfoPath)) {
						try {
							fs.unlinkSync(keyInfoPath);
							logger.info(`[transcode-video-operation] (${filename}) HLS keyinfo file cleaned up: ${keyInfoPath}`);
						} catch (cleanupError) {
							logger.warn(`[transcode-video-operation] (${filename}) Error cleaning up HLS keyinfo file:`, cleanupError);
						}
					}
				}
			} else {
				logger.info(`[transcode-video-operation] (${filename}) Transcoded files already exist, skipping transcoding`);

				// Even if skipping transcoding, we should clean up the keyinfo file we just created
				if (keyInfoPath && fs.existsSync(keyInfoPath)) {
					try {
						fs.unlinkSync(keyInfoPath);
						logger.info(`[transcode-video-operation] (${filename}) HLS keyinfo file cleaned up (skipped transcoding): ${keyInfoPath}`);
					} catch (cleanupError) {
						logger.warn(`[transcode-video-operation] (${filename}) Error cleaning up HLS keyinfo file:`, cleanupError);
					}
				}
			}

			// Generate master playlist dynamically based on available quality files
			const m3u8Content: string[] = ['#EXTM3U', '#EXT-X-VERSION:3'];

			// Add available quality streams (only if the file exists and has content)
			for (const quality of qualitiesRaw) {
				const qualityFile = `${outputDir}/${filename}_${quality.id}p.m3u8`;
				if (fs.existsSync(qualityFile) && fs.statSync(qualityFile).size > 0) {
					switch (quality.id) {
						case 240:
							m3u8Content.push('#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240', `${filename}_240p.m3u8`);
							break;
						case 480:
							m3u8Content.push('#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480', `${filename}_480p.m3u8`);
							break;
						case 720:
							m3u8Content.push('#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720', `${filename}_720p.m3u8`);
							break;
						case 1080:
							m3u8Content.push('#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080', `${filename}_1080p.m3u8`);
							break;
						case 2160:
							m3u8Content.push('#EXT-X-STREAM-INF:BANDWIDTH=15000000,RESOLUTION=3840x2160', `${filename}_2160p.m3u8`);
							break;
					}
				}
			}

			// Only write master playlist if we have at least one quality stream
			if (m3u8Content.length <= 2) {
				logger.error(`[transcode-video-operation] (${filename}) No valid quality playlists found, cannot create master playlist`);
				return {
					error: 'No valid quality playlists found, cannot create master playlist'
				};
			}

			const masterPlaylistPath = `${outputDir}/${filename}_master.m3u8`;
			fs.writeFileSync(masterPlaylistPath, m3u8Content.join('\n'));

			// Verify master playlist was created successfully
			if (!fs.existsSync(masterPlaylistPath) || fs.statSync(masterPlaylistPath).size === 0) {
				logger.error(`[transcode-video-operation] (${filename}) Failed to create master playlist: ${masterPlaylistPath}`);
				return {
					error: `Failed to create master playlist: ${masterPlaylistPath}`
				};
			}

			logger.info(`[transcode-video-operation] (${filename}) Master playlist created: ${filename}_master.m3u8`);

			// Check if thumbnail already exists in Directus before extracting
			const thumbnailFileName = `${filename}_thumb.jpg`;
			const { FilesService } = services;
			const filesService = new FilesService({
				schema: await getSchema(),
			});

			const thumbnailFilter: any = {
				filename_disk: { _eq: thumbnailFileName },
				storage: { _eq: targetStorageAdapter },
				folder: { _eq: targetFolderId }
			};

			const existingThumbnails = await filesService.readByQuery({
				filter: thumbnailFilter,
				limit: 1
			});

			if (existingThumbnails && Array.isArray(existingThumbnails) && existingThumbnails.length > 0) {
				const existingThumbnail = existingThumbnails[0];
				thumbnailId = existingThumbnail?.id || existingThumbnail?.data?.id || (typeof existingThumbnail === 'string' ? existingThumbnail : null);
				if (thumbnailId) {
					logger.info(`[transcode-video-operation] (${filename}) Thumbnail already exists in Directus: ${thumbnailId}, reusing`);
				}
			}

			// Extract thumbnail only if it doesn't exist in Directus
			const thumbnailPath = `${outputDir}/${thumbnailFileName}`;
			if (!thumbnailId) {
				try {
					await extractThumbnail(filePath, thumbnailPath);
					// Verify thumbnail was created and has content
					if (!fs.existsSync(thumbnailPath) || fs.statSync(thumbnailPath).size === 0) {
						throw new Error(`Thumbnail extraction failed: file does not exist or is empty`);
					}
					logger.info(`[transcode-video-operation] (${filename}) Thumbnail extracted`);
				} catch (error) {
					logger.error(`[transcode-video-operation] (${filename}) Error extracting thumbnail:`, error);
					// Don't proceed with thumbnail upload if extraction failed
					thumbnailId = null;
				}
			} else {
				// Thumbnail exists in Directus, skip extraction
				logger.info(`[transcode-video-operation] (${filename}) Skipping thumbnail extraction (already exists)`);
			}

			// Upload thumbnail first if it exists (or use existing one)
			if (thumbnailId) {
				// Thumbnail already exists in Directus, just add to fileIdMap
				fileIdMap[path.basename(thumbnailPath)] = thumbnailId;
				uploadedFiles.push({ filename_disk: path.basename(thumbnailPath), id: thumbnailId });
			} else if (fs.existsSync(thumbnailPath)) {
				// Thumbnail was just extracted, verify it has content before uploading
				const thumbnailSize = fs.statSync(thumbnailPath).size;
				if (thumbnailSize === 0) {
					const thumbnailAction = targetStorageDriver === 'local' ? 'register' : 'upload';
					logger.error(`[transcode-video-operation] (${filename}) Thumbnail file is empty, cannot ${thumbnailAction}`);
				} else {
					try {
						// Get thumbnail dimensions
						let thumbnailWidth: number | null = null;
						let thumbnailHeight: number | null = null;
						try {
							const imageMetadata = await getImageMetadata(thumbnailPath);
							thumbnailWidth = imageMetadata.width;
							thumbnailHeight = imageMetadata.height;
							logger.info(`[transcode-video-operation] (${filename}) Thumbnail dimensions: ${thumbnailWidth}x${thumbnailHeight}`);
						} catch (error) {
							logger.warn(`[transcode-video-operation] (${filename}) Could not get thumbnail dimensions:`, error);
						}

						// Upload thumbnail with metadata
						thumbnailId = await uploadFileToDirectus(thumbnailPath, targetFolderId, {
							mimetype: 'image/jpeg',
							width: thumbnailWidth,
							height: thumbnailHeight
						});
						fileIdMap[path.basename(thumbnailPath)] = thumbnailId;
						uploadedFiles.push({ filename_disk: path.basename(thumbnailPath), id: thumbnailId });
						const thumbnailAction = targetStorageDriver === 'local' ? 'registered' : 'uploaded';
						logger.info(`[transcode-video-operation] (${filename}) Thumbnail ${thumbnailAction}: ${thumbnailId}`);
					} catch (error) {
						const thumbnailAction = targetStorageDriver === 'local' ? 'registering' : 'uploading';
						logger.error(`[transcode-video-operation] (${filename}) Error ${thumbnailAction} thumbnail:`, error);
					}
				}
			}

			// --- Upload / Persist HLS Encryption Key ---
			if (fs.existsSync(keyFileLocalPath)) {
				try {
					let keyUploadPath = keyFileLocalPath;
					const keyStorageDriver = getStorageDriver(keyStorageAdapter);

					if (keyStorageDriver === 'local') {
						const keyStorageRoot = resolveStorage(keyStorageAdapter);
						if (keyStorageRoot) {
							const basePath = process.env.PWD || '/directus';
							const targetKeyStorageDir = path.join(basePath, keyStorageRoot);
							if (!fs.existsSync(targetKeyStorageDir)) {
								try {
									fs.mkdirSync(targetKeyStorageDir, { recursive: true, mode: 0o755 });
								} catch (dirErr) {
									logger.warn(`[transcode-video-operation] (${filename}) Could not create key storage dir ${targetKeyStorageDir}:`, dirErr);
								}
							}
							const targetKeyPath = path.join(targetKeyStorageDir, keyFilename);
							try {
								fs.copyFileSync(keyFileLocalPath, targetKeyPath);
								keyUploadPath = targetKeyPath;
								logger.info(`[transcode-video-operation] (${filename}) Saved encryption key to local storage root: ${targetKeyPath}`);
							} catch (copyKeyErr) {
								logger.warn(`[transcode-video-operation] (${filename}) Could not copy key to local storage root ${targetKeyPath}:`, copyKeyErr);
							}
						}
					}

					logger.info(`[transcode-video-operation] (${filename}) Registering/Uploading HLS encryption key: ${keyFilename} to key storage: ${keyStorageAdapter}`);
					const keyId = await uploadFileToDirectus(keyUploadPath, targetFolderId, {
						mimetype: 'application/octet-stream',
						storage: keyStorageAdapter
					});
					fileIdMap[keyFilename] = keyId;
					uploadedFiles.push({ filename_disk: keyFilename, id: keyId });
					logger.info(`[transcode-video-operation] (${filename}) HLS encryption key successfully saved to storage (${keyStorageAdapter}) with File ID: ${keyId} (filename: ${keyFilename})`);
				} catch (error) {
					logger.error(`[transcode-video-operation] (${filename}) Error uploading HLS key ${keyFilename}:`, error);
				}
			}
			// ----------------------------------

			// Collect only segment files (not playlists) - we'll rebuild playlists with UUIDs after uploading segments
			const segmentFiles = new Set<string>();

			// For each quality level, read the playlist to get the segment files
			for (const quality of qualitiesRaw) {
				const qualityPlaylistPath = `${outputDir}/${filename}_${quality.id}p.m3u8`;
				if (fs.existsSync(qualityPlaylistPath)) {
					// Read playlist to get segment file names
					const playlistContent = fs.readFileSync(qualityPlaylistPath, 'utf-8');
					const playlistLines = playlistContent.split('\n');
					for (const line of playlistLines) {
						const trimmedLine = line.trim();
						// Skip comments and empty lines
						if (trimmedLine && !trimmedLine.startsWith('#')) {
							// This is a segment file name
							// Remove any path prefix if present
							const segmentFile = path.basename(trimmedLine);
							if (segmentFile.endsWith('.ts') && segmentFile.startsWith(filename)) {
								// Only add if the file actually exists on disk
								const segmentFilePath = `${outputDir}/${segmentFile}`;
								if (fs.existsSync(segmentFilePath)) {
									segmentFiles.add(segmentFile);
								}
							}
						}
					}
				}
			}

			// Upload ONLY segment files first (not playlists - we'll rebuild them with UUIDs)
			logger.info(`[transcode-video-operation] (${filename}) Uploading ${segmentFiles.size} segment files...`);
			for (const segmentFile of segmentFiles) {
				const filePathToUpload = `${outputDir}/${segmentFile}`;
				if (!fs.existsSync(filePathToUpload)) {
					logger.warn(`[transcode-video-operation] (${filename}) Segment file not found on disk: ${segmentFile}`);
					continue;
				}

				try {
					const fileId = await uploadFileToDirectus(filePathToUpload, targetFolderId);
					fileIdMap[segmentFile] = fileId;
					uploadedFiles.push({ filename_disk: segmentFile, id: fileId });
				} catch (error) {
					logger.error(`[transcode-video-operation] (${filename}) Error uploading segment ${segmentFile}:`, error);
				}
			}

			// Determine reference type for playlists
			// Default to filename_disk (standard HLS format). If using cloud storage (e.g. Cloudflare R2) or storage_adapter === 'r2', always ensure filename_disk is used.
			const useFilenameDisk = playlist_reference_type === 'filename_disk' || storage_adapter === 'r2' || targetStorageDriver !== 'local' || playlist_reference_type !== 'id';
			const referenceTypeLabel = useFilenameDisk ? 'filename_disk' : 'file IDs';
			logger.info(`[transcode-video-operation] (${filename}) Rebuilding playlists with ${referenceTypeLabel}...`);

			// Rebuild quality playlists with UUIDs and upload them
			for (const quality of qualitiesRaw) {
				const qualityPlaylistPath = `${outputDir}/${filename}_${quality.id}p.m3u8`;
				if (fs.existsSync(qualityPlaylistPath)) {
					// Verify file has content before rebuilding
					const fileSize = fs.statSync(qualityPlaylistPath).size;
					if (fileSize === 0) {
						logger.warn(`[transcode-video-operation] (${filename}) Playlist file ${quality.id}p.m3u8 is empty, skipping rebuild`);
						continue;
					}

					// Rebuild playlist: replace filenames with UUIDs from fileIdMap
					const rebuiltContent = rebuildPlaylist(qualityPlaylistPath, fileIdMap, useFilenameDisk, logger);
					if (!rebuiltContent || rebuiltContent.trim().length === 0) {
						const playlistAction = targetStorageDriver === 'local' ? 'registration' : 'upload';
						logger.warn(`[transcode-video-operation] (${filename}) Rebuilt playlist content is empty for ${quality.id}p, skipping ${playlistAction}`);
						continue;
					}

					// Write rebuilt playlist to disk
					fs.writeFileSync(qualityPlaylistPath, rebuiltContent);

					// Upload the rebuilt playlist (first time - not a re-upload)
					try {
						const playlistBasename = path.basename(qualityPlaylistPath);
						const playlistId = await uploadFileToDirectus(qualityPlaylistPath, targetFolderId);
						fileIdMap[playlistBasename] = playlistId;
						uploadedFiles.push({ filename_disk: playlistBasename, id: playlistId });
					} catch (error) {
						const playlistAction = targetStorageDriver === 'local' ? 'registering' : 'uploading';
						logger.error(`[transcode-video-operation] (${filename}) Error ${playlistAction} ${quality.id}p playlist:`, error);
					}
				}
			}

			// Rebuild master playlist (masterPlaylistPath was already defined when creating it)
			if (!fs.existsSync(masterPlaylistPath)) {
				logger.error(`[transcode-video-operation] (${filename}) Master playlist file does not exist: ${masterPlaylistPath}`);
				return {
					error: `Master playlist file does not exist: ${masterPlaylistPath}`
				};
			}

			const masterFileSize = fs.statSync(masterPlaylistPath).size;
			if (masterFileSize === 0) {
				logger.error(`[transcode-video-operation] (${filename}) Master playlist file is empty: ${masterPlaylistPath}`);
				return {
					error: `Master playlist file is empty: ${masterPlaylistPath}`
				};
			}

			const masterContent = fs.readFileSync(masterPlaylistPath, 'utf-8');
			if (!masterContent || masterContent.trim().length === 0) {
				logger.error(`[transcode-video-operation] (${filename}) Master playlist content is empty: ${masterPlaylistPath}`);
				return {
					error: `Master playlist content is empty: ${masterPlaylistPath}`
				};
			}

			const masterLines = masterContent.split('\n');
			const newMasterLines: string[] = [];

			// UUID pattern: 8-4-4-4-12 hexadecimal characters
			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

			for (const line of masterLines) {
				if (line.startsWith('#') || line.trim() === '') {
					newMasterLines.push(line);
				} else {
					// Replace quality playlist filename with file ID or filename_disk
					let playlistFilename = line.trim();
					// Strip /assets/ prefix if present
					if (playlistFilename.startsWith('/assets/')) {
						playlistFilename = playlistFilename.substring('/assets/'.length);
					}

					// If the line is already a UUID (file ID) and we're using file IDs, keep it as-is
					if (uuidPattern.test(playlistFilename) && !useFilenameDisk) {
						newMasterLines.push(playlistFilename);
						continue;
					}

					// Also try with just the basename
					const basename = path.basename(playlistFilename);
					const playlistId = fileIdMap[playlistFilename] || fileIdMap[basename];
					if (playlistId) {
						if (useFilenameDisk) {
							// Use filename_disk (the original filename)
							newMasterLines.push(playlistFilename);
						} else {
							// Use file ID (relative to master playlist location)
							newMasterLines.push(playlistId);
						}
					} else {
						// Keep original if not found (might be from previous run with different file IDs)
						newMasterLines.push(line);
					}
				}
			}

			fs.writeFileSync(masterPlaylistPath, newMasterLines.join('\n'));

			// Register/upload master playlist
			try {
				masterId = await uploadFileToDirectus(masterPlaylistPath, targetFolderId);
				fileIdMap[path.basename(masterPlaylistPath)] = masterId;
				uploadedFiles.push({ filename_disk: path.basename(masterPlaylistPath), id: masterId });
			} catch (error) {
				const masterAction = targetStorageDriver === 'local' ? 'registering' : 'uploading';
				logger.error(`[transcode-video-operation] (${filename}) Error ${masterAction} master playlist:`, error);
			}
		}

		// AI Caption & Speech2Text Generation
		let subtitleId: string | null = null;
		let audioId: string | null = null;
		let s2tSubtitleId: string | null = null;
		let s2tJsonId: string | null = null;
		let s2tErrorMessage: string | null = null;
		let tempAudioPath: string | null = null;

		let runAudioExtraction = false;
		if (process_mode === 'all' && (generate_captions || generate_speech2text)) {
			runAudioExtraction = true;
		} else if (process_mode === 'audio_only' || process_mode === 'hls_and_audio') {
			runAudioExtraction = true;
		} else if (process_mode === 'transcription_only' && !isAudioInput) {
			runAudioExtraction = true;
		}

		if (runAudioExtraction) {
			try {
				const tempDir = path.join(process.env.PWD || '/directus', 'tmp', 'transcode');
				if (!fs.existsSync(tempDir)) {
					fs.mkdirSync(tempDir, { recursive: true, mode: 0o755 });
				}
				tempAudioPath = path.join(tempDir, `${filename}_temp_audio.mp3`);

				let forceMono = false;
				if (process_mode === 'audio_only' || process_mode === 'hls_and_audio') {
					forceMono = true;
				} else if (process_mode === 'transcription_only') {
					forceMono = true;
				} else if (process_mode === 'all' && generate_speech2text && speech2text_diarization) {
					forceMono = true;
				}

				logger.info(`[transcode-video-operation] (${filename}) Extracting audio track. Force mono: ${forceMono}`);
				await extractAudio(filePath, tempAudioPath, forceMono, validatedNice);
			} catch (extractError) {
				logger.error(`[transcode-video-operation] (${filename}) Audio extraction failed: %s`, extractError instanceof Error ? extractError.stack || extractError.message : String(extractError));
			}
		} else if (process_mode === 'transcription_only' && isAudioInput) {
			tempAudioPath = filePath;
			logger.info(`[transcode-video-operation] (${filename}) Using existing audio input file directly for transcription: ${tempAudioPath}`);
		}

		if (process_mode === 'all' && generate_captions && tempAudioPath && fs.existsSync(tempAudioPath)) {
			try {
				logger.info(`[transcode-video-operation] (${filename}) Initiating AI subtitle generation...`);

				// 2. Transcribe audio to WebVTT subtitle
				const vttContent = await transcribeAudio(tempAudioPath);

				// 3. Save WebVTT file to target outputDir
				const subtitleFilename = `${filename}_subtitle.vtt`;
				const subtitleLocalPath = path.join(outputDir, subtitleFilename);
				fs.writeFileSync(subtitleLocalPath, vttContent);
				logger.info(`[transcode-video-operation] (${filename}) Subtitle file saved locally: ${subtitleLocalPath}`);

				// 4. Upload WebVTT file to Directus
				logger.info(`[transcode-video-operation] (${filename}) Uploading subtitle file to Directus folder...`);
				subtitleId = await uploadFileToDirectus(subtitleLocalPath, targetFolderId, {
					mimetype: 'text/vtt'
				});

				if (subtitleId) {
					fileIdMap[subtitleFilename] = subtitleId;
					uploadedFiles.push({ filename_disk: subtitleFilename, id: subtitleId });
					logger.info(`[transcode-video-operation] (${filename}) Subtitle uploaded successfully. ID: ${subtitleId}`);
				}
			} catch (captionError) {
				logger.error(`[transcode-video-operation] (${filename}) Caption generation failed: %s`, captionError instanceof Error ? captionError.stack || captionError.message : String(captionError));
			}
		}

		// Determine S2T and audio permanent save options
		const shouldRunSpeech2Text = (process_mode === 'transcription_only') || (process_mode === 'all' && generate_speech2text);

		if (tempAudioPath && fs.existsSync(tempAudioPath)) {
			const shouldSaveAudioPermanently = (process_mode === 'audio_only') ||
				(process_mode === 'hls_and_audio') ||
				(process_mode === 'all' && generate_speech2text) ||
				(process_mode === 'transcription_only' && !isAudioInput);

			if (shouldSaveAudioPermanently) {
				try {
					const audioFilename = `${filename}_mono.mp3`;
					let audioUploadPath = tempAudioPath;

					// Resolve audioStorageAdapter
					let audioStorageAdapter: string;
					if (audio_storage_adapter === 'target') {
						audioStorageAdapter = targetStorageAdapter;
					} else if (audio_storage_adapter === 'custom' && audio_target_storage) {
						if (!validateStorageExists(audio_target_storage)) {
							throw new Error(`Custom audio storage location "${audio_target_storage}" does not exist in Directus configuration.`);
						}
						audioStorageAdapter = audio_target_storage;
					} else {
						audioStorageAdapter = defaultStorageAdapter;
					}

					const audioStorageDriver = getStorageDriver(audioStorageAdapter);
					if (audioStorageDriver === 'local') {
						const audioStorageRoot = resolveStorage(audioStorageAdapter);
						if (audioStorageRoot) {
							const basePath = process.env.PWD || '/directus';
							const targetAudioStorageDir = path.join(basePath, audioStorageRoot);
							if (!fs.existsSync(targetAudioStorageDir)) {
								try {
									fs.mkdirSync(targetAudioStorageDir, { recursive: true, mode: 0o755 });
								} catch (dirErr) {
									logger.warn(`[transcode-video-operation] (${filename}) Could not create audio storage dir ${targetAudioStorageDir}:`, dirErr);
								}
							}
							const targetAudioPath = path.join(targetAudioStorageDir, audioFilename);
							try {
								fs.copyFileSync(tempAudioPath, targetAudioPath);
								audioUploadPath = targetAudioPath;
								logger.info(`[transcode-video-operation] (${filename}) Saved mono mp3 audio to local storage root: ${targetAudioPath}`);
							} catch (copyAudioErr) {
								logger.warn(`[transcode-video-operation] (${filename}) Could not copy audio to local storage root ${targetAudioPath}:`, copyAudioErr);
							}
						}
					}

					logger.info(`[transcode-video-operation] (${filename}) Uploading permanent mono mp3 audio to audio storage: ${audioStorageAdapter}...`);
					audioId = await uploadFileToDirectus(audioUploadPath, targetFolderId, {
						mimetype: 'audio/mpeg',
						storage: audioStorageAdapter
					});

					if (audioId) {
						fileIdMap[audioFilename] = audioId;
						uploadedFiles.push({ filename_disk: audioFilename, id: audioId });
						logger.info(`[transcode-video-operation] (${filename}) Permanent mono mp3 audio uploaded/registered successfully. ID: ${audioId}`);
					} else {
						throw new Error("Failed to upload permanent audio file to Directus");
					}
				} catch (audioError) {
					logger.error(`[transcode-video-operation] (${filename}) Failed to save/upload permanent audio: %s`, audioError instanceof Error ? audioError.message : String(audioError));
				}
			} else if (process_mode === 'transcription_only' && isAudioInput) {
				// Re-use the existing file ID from Directus
				try {
					let fileId: string | null = null;
					if (typeof file === 'string') {
						fileId = file;
					} else if (fileObject.id) {
						fileId = String(fileObject.id);
					} else if ((fileObject as any).data?.id) {
						fileId = String((fileObject as any).data.id);
					}
					audioId = fileId;
					logger.info(`[transcode-video-operation] (${filename}) Reusing existing input audio file ID for transcription: ${audioId}`);
				} catch (e) {
					logger.error(`[transcode-video-operation] (${filename}) Error getting audio file ID: %s`, e instanceof Error ? e.message : String(e));
				}
			}
		}

		if (shouldRunSpeech2Text && audioId) {
			let jobSelfUrl: string | null = null;
			let subscriptionKey: string | null = null;
			try {
				logger.info(`[transcode-video-operation] (${filename}) Initiating AI Speech2Text flow...`);

				// Submit Speech2Text job to Azure
				const speech2textUrl = speech2text_endpoint || 'https://swedencentral.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions';
				subscriptionKey = speech2text_subscription_key || (env.SPEECH2TEXT_SUBSCRIPTION_KEY as string);

				if (!subscriptionKey) {
					throw new Error("Azure Speech2Text subscription key is not configured.");
				}

				const audioUrl = speech2text_access_token
					? `${baseUrl}/assets/${audioId}.mp3?access_token=${speech2text_access_token}`
					: `${baseUrl}/assets/${audioId}.mp3`;

				const s2tPayload = {
					contentUrls: [
						audioUrl
					],
					locale: speech2text_locale || 'id-ID',
					displayName: `${filename}_s2t`,
					properties: {
						diarizationEnabled: speech2text_diarization !== undefined ? speech2text_diarization : true,
						outputFormations: [
							{
								format: "SRT"
							}
						]
					}
				};

				logger.info(`[transcode-video-operation] (${filename}) Submitting Speech2Text job to Azure Speech Services: ${speech2textUrl}`);

				const postResponse = await fetch(speech2textUrl, {
					method: 'POST',
					headers: {
						'Ocp-Apim-Subscription-Key': subscriptionKey,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(s2tPayload)
				});

				if (!postResponse.ok) {
					const errText = await postResponse.text();
					throw new Error(`Speech2Text job submission failed (HTTP ${postResponse.status}): ${errText}`);
				}

				const jobData = await postResponse.json() as any;
				jobSelfUrl = jobData.self;
				const jobFilesUrl = jobData.links?.files;

				if (!jobSelfUrl) {
					throw new Error("Speech2Text response missing job self URL");
				}

				logger.info(`[transcode-video-operation] (${filename}) Speech2Text job submitted. Self URL: ${jobSelfUrl}`);

				// Poll status until Succeeded or Failed
				let status = jobData.status || 'NotStarted';
				
				let pollIntervalSeconds = 30; // default 30 seconds
				if (speech2text_poll_interval !== undefined && speech2text_poll_interval !== null) {
					const parsed = parseInt(String(speech2text_poll_interval), 10);
					if (!isNaN(parsed) && parsed > 0) {
						pollIntervalSeconds = parsed;
					}
				}
				const pollIntervalMs = pollIntervalSeconds * 1000;

				let timeoutSeconds = 1800; // default 30 minutes (1800 seconds)
				if (speech2text_timeout !== undefined && speech2text_timeout !== null) {
					const parsed = parseInt(String(speech2text_timeout), 10);
					if (!isNaN(parsed) && parsed > 0) {
						timeoutSeconds = parsed;
					}
				}
				const maxPollTimeMs = timeoutSeconds * 1000;
				logger.info(`[transcode-video-operation] (${filename}) Polling transcription job with a timeout of ${timeoutSeconds} seconds (${Math.round(timeoutSeconds / 60)} minutes)`);

				let elapsedMs = 0;
				let lastPollData = jobData;

				while (status !== 'Succeeded' && status !== 'Failed') {
					if (elapsedMs >= maxPollTimeMs) {
						throw new Error(`Speech2Text job timed out after ${maxPollTimeMs / 1000} seconds`);
					}

					await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
					elapsedMs += pollIntervalMs;

					const pollResponse = await fetch(jobSelfUrl, {
						headers: {
							'Ocp-Apim-Subscription-Key': subscriptionKey
						}
					});

					if (!pollResponse.ok) {
						logger.warn(`[transcode-video-operation] (${filename}) Failed to poll Speech2Text job status (HTTP ${pollResponse.status})`);
						continue;
					}

					const pollData = await pollResponse.json() as any;
					lastPollData = pollData;
					status = pollData.status;
					logger.info(`[transcode-video-operation] (${filename}) Polling Speech2Text job status... Status: ${status}`);
				}

				if (status === 'Failed') {
					const azureError = lastPollData?.properties?.error;
					const azureErrorCode = azureError?.code || 'Unknown';
					const azureErrorMessage = azureError?.message || 'No detailed error message';
					throw new Error(`Speech2Text job failed on Azure Speech Services. Code: ${azureErrorCode}, Message: ${azureErrorMessage}`);
				}

				// Get files from files endpoint
				const filesUrl = jobFilesUrl || `${jobSelfUrl}/files`;
				logger.info(`[transcode-video-operation] (${filename}) Fetching Speech2Text job files list from ${filesUrl}`);

				const filesResponse = await fetch(filesUrl, {
					headers: {
						'Ocp-Apim-Subscription-Key': subscriptionKey
					}
				});

				if (!filesResponse.ok) {
					throw new Error(`Failed to fetch Speech2Text files (HTTP ${filesResponse.status})`);
				}

				const filesData = await filesResponse.json() as any;
				const filesList = filesData.values || [];
				const transcriptionFile = filesList.find((f: any) => f.name === 'contenturl_0.json' || f.kind === 'Transcription');

				if (!transcriptionFile || !transcriptionFile.links?.contentUrl) {
					throw new Error("Could not find transcription contenturl_0.json file in job files list");
				}

				const contentUrl = transcriptionFile.links.contentUrl;
				logger.info(`[transcode-video-operation] (${filename}) Downloading transcription JSON from SAS URL: ${contentUrl}`);

				// Download transcription JSON content
				const contentResponse = await fetch(contentUrl);
				if (!contentResponse.ok) {
					throw new Error(`Failed to download transcription JSON from SAS URL (HTTP ${contentResponse.status})`);
				}

				const transcriptionJson = await contentResponse.json() as any;

				// Convert to SRT
				logger.info(`[transcode-video-operation] (${filename}) Converting transcription JSON to SRT format...`);
				const srtContent = convertAzureJsonToSrt(transcriptionJson, speech2text_speaker_map);

				// Save raw JSON transcription permanently to target outputDir
				const s2tJsonFilename = `${filename}_s2t_transcription.json`;
				const s2tJsonLocalPath = path.join(outputDir, s2tJsonFilename);
				fs.writeFileSync(s2tJsonLocalPath, JSON.stringify(transcriptionJson, null, 2));
				logger.info(`[transcode-video-operation] (${filename}) Speech2Text raw JSON saved locally: ${s2tJsonLocalPath}`);

				// Upload raw JSON to Directus
				logger.info(`[transcode-video-operation] (${filename}) Uploading Speech2Text raw JSON file to Directus folder...`);
				s2tJsonId = await uploadFileToDirectus(s2tJsonLocalPath, targetFolderId, {
					mimetype: 'application/json'
				});

				if (s2tJsonId) {
					fileIdMap[s2tJsonFilename] = s2tJsonId;
					uploadedFiles.push({ filename_disk: s2tJsonFilename, id: s2tJsonId });
					logger.info(`[transcode-video-operation] (${filename}) Speech2Text raw JSON uploaded successfully. ID: ${s2tJsonId}`);
				}

				// Save SRT file to target outputDir
				const s2tSubtitleFilename = `${filename}_s2t_subtitle.srt`;
				const s2tSubtitleLocalPath = path.join(outputDir, s2tSubtitleFilename);
				fs.writeFileSync(s2tSubtitleLocalPath, srtContent);
				logger.info(`[transcode-video-operation] (${filename}) Speech2Text subtitle saved locally: ${s2tSubtitleLocalPath}`);

				// Upload SRT to Directus
				logger.info(`[transcode-video-operation] (${filename}) Uploading Speech2Text subtitle file to Directus folder...`);
				s2tSubtitleId = await uploadFileToDirectus(s2tSubtitleLocalPath, targetFolderId, {
					mimetype: 'application/x-subrip'
				});

				if (s2tSubtitleId) {
					fileIdMap[s2tSubtitleFilename] = s2tSubtitleId;
					uploadedFiles.push({ filename_disk: s2tSubtitleFilename, id: s2tSubtitleId });
					logger.info(`[transcode-video-operation] (${filename}) Speech2Text subtitle uploaded successfully. ID: ${s2tSubtitleId}`);
				}
			} catch (s2tError) {
				s2tErrorMessage = s2tError instanceof Error ? s2tError.message : String(s2tError);
				logger.error(`[transcode-video-operation] (${filename}) Speech2Text flow failed: %s`, s2tError instanceof Error ? s2tError.stack || s2tError.message : String(s2tError));
			} finally {
				// Clean up the Azure Speech job if created
				if (jobSelfUrl && subscriptionKey) {
					try {
						logger.info(`[transcode-video-operation] (${filename}) Cleaning up Azure Speech2Text transcription job...`);
						await fetch(jobSelfUrl, {
							method: 'DELETE',
							headers: {
								'Ocp-Apim-Subscription-Key': subscriptionKey
							}
						});
						logger.info(`[transcode-video-operation] (${filename}) Azure Speech2Text job cleaned up successfully`);
					} catch (deleteError) {
						logger.warn(`[transcode-video-operation] (${filename}) Failed to delete Azure Speech2Text job:`, deleteError);
					}
				}
			}
		}

		const filesAction = targetStorageDriver === 'local' ? 'registered' : 'uploaded';
		logger.info(`[transcode-video-operation] (${filename}) All files ${filesAction} to Directus: ${uploadedFiles.length} files total`);

		// Clean up local transcoded files if using cloud storage
		// For local storage, files should remain on disk
		if (!isLocalTarget) {
			try {
				logger.info(`[transcode-video-operation] (${filename}) Cleaning up local transcoded files (using cloud storage: ${targetStorageAdapter})...`);
				const keyStorageDriver = getStorageDriver(keyStorageAdapter);
				const isKeyLocalStorage = keyStorageDriver === 'local';
				const keyStoragePath = isKeyLocalStorage ? resolveStorage(keyStorageAdapter) : null;
				const basePath = process.env.PWD || '/directus';
				const keyStorageFullPath = keyStoragePath ? path.join(basePath, keyStoragePath) : null;

				const allTranscodedFiles = readFiles(outputDir);
				for (const fileToDelete of allTranscodedFiles) {
					// Don't delete the source file
					if (fileToDelete === fileObject.filename_disk) {
						continue;
					}
					// Don't delete key file if it's stored in local storage output directory
					if (fileToDelete === keyFilename && isKeyLocalStorage && outputDir === keyStorageFullPath) {
						logger.info(`[transcode-video-operation] (${filename}) Preserving encryption key in local storage: ${keyFilename}`);
						continue;
					}
					const filePathToDelete = `${outputDir}/${fileToDelete}`;
					try {
						fs.unlinkSync(filePathToDelete);
					} catch (error) {
						logger.warn(`[transcode-video-operation] (${filename}) Could not delete local file ${fileToDelete}:`, error);
					}
				}
				logger.info(`[transcode-video-operation] (${filename}) Local transcoded files cleaned up`);
			} catch (error) {
				logger.error(`[transcode-video-operation] (${filename}) Error cleaning up local files:`, error);
				// Don't fail the operation if cleanup fails
			}

			// Clean up isolated temporary output directory if target is cloud storage
			if (!isLocalTarget && fs.existsSync(outputDir)) {
				try {
					fs.rmSync(outputDir, { recursive: true, force: true });
					logger.info(`[transcode-video-operation] (${filename}) Isolated temporary transcode directory cleaned up: ${outputDir}`);
				} catch (rmErr) {
					logger.warn(`[transcode-video-operation] (${filename}) Could not delete temporary transcode directory ${outputDir}:`, rmErr);
				}
			}
		}

		// Clean up temporary source file if it was downloaded from cloud storage
		if (needsCleanup && tempSourceFile) {
			try {
				if (fs.existsSync(tempSourceFile)) {
					fs.unlinkSync(tempSourceFile);
					logger.info(`[transcode-video-operation] (${filename}) Temporary source file cleaned up: ${tempSourceFile}`);
				}
			} catch (error) {
				logger.warn(`[transcode-video-operation] (${filename}) Could not delete temporary source file ${tempSourceFile}:`, error);
			}
		}

		// Clean up temporary audio track
		if (tempAudioPath && tempAudioPath !== filePath) {
			try {
				if (fs.existsSync(tempAudioPath)) {
					fs.unlinkSync(tempAudioPath);
					logger.info(`[transcode-video-operation] (${filename}) Temporary audio track cleaned up: ${tempAudioPath}`);
				}
			} catch (error) {
				logger.warn(`[transcode-video-operation] (${filename}) Could not delete temporary audio track ${tempAudioPath}:`, error);
			}
		}

		// Determine available qualities
		const availableQualities: number[] = [];
		if (qualitiesRaw && qualitiesRaw.length > 0) {
			for (const quality of qualitiesRaw) {
				const qualityFile = `${outputDir}/${filename}_${quality.id}p.m3u8`;
				if (fs.existsSync(qualityFile)) {
					availableQualities.push(quality.id);
				}
			}
		}

		// Delete original source file if delete_source_file option is enabled
		if (delete_source_file && targetFileId) {
			try {
				logger.info(`[transcode-video-operation] (${filename}) delete_source_file is enabled. Deleting original source file record (ID: ${targetFileId})...`);
				const { FilesService } = services;
				const filesService = new FilesService({ schema: await getSchema() });
				await filesService.deleteOne(targetFileId);
				logger.info(`[transcode-video-operation] (${filename}) Original source file deleted successfully.`);
			} catch (deleteSourceErr) {
				logger.error(`[transcode-video-operation] (${filename}) Could not delete original source file ${targetFileId}:`, deleteSourceErr);
			}
		}

		return {
			master: masterId ? { id: masterId, filename_disk: `${filename}_master.m3u8` } : null,
			metadata: {
				availableQualities: availableQualities.length > 0 ? availableQualities : null,
				dimensions: metadata.width && metadata.height ? {
					width: metadata.width,
					height: metadata.height,
					isVertical: metadata.isVertical
				} : null,
				duration: metadata.duration,
				thumbnail: thumbnailId,
				subtitle: subtitleId,
				audio: audioId,
				s2t_json: s2tJsonId,
				s2t_subtitle: s2tSubtitleId,
				s2t_error: s2tErrorMessage
			},
			files: uploadedFiles
		};
	}
};
