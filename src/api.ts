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
	process_mode?: 'all' | 'hls_only' | 'audio_only' | 'transcription_only';
	keyBaseUrl?: string;
	playlist_reference_type?: 'id' | 'filename_disk';
	qualities?: string[] | string;
	threads?: number | string;
	nice?: number | string;
	storage_adapter?: 'default' | 'source' | 'custom';
	target_storage?: string;
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
			playlist_reference_type = 'id',
			qualities = ['240p', '480p', '720p', '1080p', '2160p'],
			threads = 1,
			nice,
			storage_adapter = 'default',
			target_storage,
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

		// If file is a UUID string, fetch the file from Directus
		let fileObject: File;
		if (typeof file === 'string') {
			try {
				const { FilesService } = services;
				const filesService = new FilesService({
					schema: await getSchema(),
				});

				const fileRecord = await filesService.readOne(file);
				fileObject = fileRecord as File;
				logger.info(`[transcode-video-operation] Fetched file from UUID: ${file}`);
			} catch (error) {
				logger.error(`[transcode-video-operation] Error fetching file with UUID ${file}:`, error);
				throw new Error(`Failed to fetch file with UUID ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			fileObject = file;
		}

		if (!fileObject?.filename_disk) {
			logger.info("[transcode-video-operation] Input file missing filename_disk");
			throw new Error("Input file missing filename_disk");
		}

		const filename = fileObject.filename_disk.split(('.'))[0];
		const extension = fileObject.filename_disk.substr(fileObject.filename_disk.lastIndexOf('.') + 1);

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

		// Helper function to validate if a storage location exists
		const validateStorageExists = (location: string): boolean => {
			const driverKey = `STORAGE_${location.toUpperCase()}_DRIVER`;
			const driverValue = env[driverKey];
			return !!driverValue;
		}

		// Helper functions for storage resolution (needed early for output directory determination)
		const resolveStorage = (location: string): string | null => {
			const envKey = `STORAGE_${location.toUpperCase()}_ROOT`;
			const envValue = env[envKey];

			if (envValue) {
				return String(envValue);
			} else {
				logger.warn(`[transcode-video-operation] (${filename}) No storage found for location <%s>`, location);
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
		} else if (storage_adapter === 'custom' && target_storage) {
			// Validate that the custom storage location exists
			if (!validateStorageExists(target_storage)) {
				const errorMsg = `Custom storage location "${target_storage}" does not exist. Please ensure STORAGE_${target_storage.toUpperCase()}_DRIVER is configured. Available locations: ${JSON.stringify(storageLocations)}`;
				logger.error(`[transcode-video-operation] (${filename}) ${errorMsg}`);
				throw new Error(errorMsg);
			}
			targetStorageAdapter = target_storage;
			logger.info(`[transcode-video-operation] (${filename}) Using custom storage location: ${target_storage}`);
		} else {
			// Use environment default (first configured storage location)
			targetStorageAdapter = defaultStorageAdapter;
		}

		logger.info(`[transcode-video-operation] (${filename}) Using storage adapter: ${targetStorageAdapter}`);

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
			const encryptionOptions = keyInfoPath ? `-hls_key_info_file ${keyInfoPath}` : '';

			return [
				{
					id: 240,
					options: `-vf "${pixelFormat}scale=w='min(426,iw)':h='min(240,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 22 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 400k -maxrate 428k -bufsize 600k -b:a 64k ${encryptionOptions} -hls_segment_filename ${outputDir}/${filename}_240p_%03d.ts ${outputDir}/${filename}_240p.m3u8`
				},
				{
					id: 480,
					options: `-vf "${pixelFormat}scale=w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 1400k -maxrate 1498k -bufsize 2100k -b:a 128k ${encryptionOptions} -hls_segment_filename ${outputDir}/${filename}_480p_%03d.ts ${outputDir}/${filename}_480p.m3u8`
				},
				{
					id: 720,
					options: `-vf "${pixelFormat}scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 2800k -maxrate 2996k -bufsize 4200k -b:a 128k ${encryptionOptions} -hls_segment_filename ${outputDir}/${filename}_720p_%03d.ts ${outputDir}/${filename}_720p.m3u8`
				},
				{
					id: 1080,
					options: `-vf "${pixelFormat}scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 5000k -maxrate 5350k -bufsize 7500k -b:a 192k ${encryptionOptions} -hls_segment_filename ${outputDir}/${filename}_1080p_%03d.ts ${outputDir}/${filename}_1080p.m3u8`
				},
				{
					id: 2160,
					options: `-vf "${pixelFormat}scale=w='min(3840,iw)':h='min(2160,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:a aac -ar 48000 -c:v h264 -profile:v ${profile} ${colorSpaceFlags} -crf 20 -sc_threshold 0 -g 48 -keyint_min 48 -hls_time 4 -hls_playlist_type vod -b:v 20000k -maxrate 21400k -bufsize 30000k -b:a 192k ${encryptionOptions} -hls_segment_filename ${outputDir}/${filename}_2160p_%03d.ts ${outputDir}/${filename}_2160p.m3u8`
				}
			];
		};
		const hlsFolderId = folder_id;

		const readFiles = (linkFilePath: string): string[] => {
			const data = fs.readdirSync(linkFilePath, 'utf-8').filter(fn => fn.startsWith(filename));
			return data;
		}

		// Get video/audio metadata (dimensions, duration)
		const getVideoMetadata = async (inputFile: string): Promise<VideoMetadata> => {
			return new Promise((resolve, reject) => {
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json ${inputFile}`,
					(error, stdout) => {
						if (error) {
							// Try to query just format duration as fallback (for audio inputs)
							exec(`ffprobe -v error -show_entries format=duration -of json ${inputFile}`, (err2, stdout2) => {
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
				exec(`ffmpeg -loglevel warning -y -i ${inputFile} -ss 1 -vframes 1 -q:v 2 ${outputPath}`, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
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
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of json ${imagePath}`,
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
				const isLocalStorage = targetStorageDriver === 'local';

				// Only log for cloud storage uploads, not for local storage registration
				if (!isLocalStorage) {
					logger.info(`[transcode-video-operation] (${filename}) Uploading file: ${fileName} (${fileSizeInBytes} bytes) to storage: ${targetStorageAdapter}`);
				}

				const types: Record<string, string> = {
					ts: "video/mp2t",
					mp4: "video/mp4",
					jpeg: "image/jpeg",
					jpg: "image/jpeg",
					m3u8: "application/x-mpegurl"
				};

				const storage = targetStorageAdapter || options.storage;
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
					if (isLocalStorage) {
						// For local storage: file is already on disk, just create the database record
						// Use createOne() to avoid moving/copying the file
						fileId = await filesService.createOne(fileData);
					} else {
						// For cloud storage: create a stream and upload to the configured storage adapter
						const fileStream = fs.createReadStream(filePath);

						// Handle stream errors
						fileStream.on('error', (streamError) => {
							logger.error(`[transcode-video-operation] (${filename}) File stream error for ${fileName}:`, streamError);
						});

						// Use uploadOne() for cloud storage to upload the file stream
						// Signature: uploadOne(stream, data, existingPrimaryKey?)
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
					const actionVerb = isLocalStorage ? 'registering' : 'uploading';
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

						// Only replace if it's a relative path (not a full URL from keyBaseUrl)
						// and we're using file IDs
						if (!useFilenameDisk && !originalKeyURI.includes('://')) {
							const keyId = fileIdMap[originalKeyURI] || fileIdMap[keyBasename];
							if (keyId) {
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
							// Use filename_disk (the original filename) - only when explicitly requested
							newLines.push(filename);
						} else {
							// Use file ID (UUID) - this is the default behavior
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
				const command = `${nicePrefix}ffmpeg -loglevel warning -y -i ${inputFile} -threads ${validatedThreads} ${quality.options}`;
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
				const command = `${nicePrefix}ffmpeg -loglevel warning -y -i ${inputFile} -vn -acodec libmp3lame ${audioParams} -q:a 4 ${outputPath}`;

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

		// Handle source file location (local vs cloud storage)
		let filePath: string;
		let tempSourceFile: string | null = null;
		let needsCleanup = false;

		// Check storage driver to determine if file is local or cloud storage
		const sourceStorageDriver = getStorageDriver(fileObject.storage);
		const isLocalSource = sourceStorageDriver === 'local';

		if (isLocalSource) {
			// Local storage: file is on disk
			const storagePath = resolveStorage(fileObject.storage);
			if (!storagePath) {
				return {
					error: `No storage found for location <${fileObject.storage}>`
				}
			}

			// Construct file path - use process.env.PWD or fallback to /directus
			const basePath = process.env.PWD || '/directus';
			filePath = path.join(basePath, `${storagePath}/${fileObject.filename_disk}`);

			// Verify source file exists
			if (!fs.existsSync(filePath)) {
				logger.error(`[transcode-video-operation] (${filename}) Source file not found: %s`, filePath);
				return {
					error: `Source file not found: ${filePath}`
				};
			}
		} else {
			// Cloud storage: need to download file first
			logger.info(`[transcode-video-operation] (${filename}) Source file is in cloud storage (${fileObject.storage}, driver: ${sourceStorageDriver}), downloading to temporary location...`);
			try {
				// Get file ID from fileObject - try multiple possible locations
				let fileId: string | null = null;
				if (typeof file === 'string') {
					fileId = file;
				} else if (fileObject.id) {
					fileId = String(fileObject.id);
				} else if ((fileObject as any).data?.id) {
					fileId = String((fileObject as any).data.id);
				}

				if (!fileId) {
					logger.error(`[transcode-video-operation] (${filename}) Cannot download source file: file ID not found. fileObject keys: ${Object.keys(fileObject).join(', ')}`);
					return {
						error: `Cannot download source file: file ID not found in fileObject`
					};
				}

				// Create temporary directory for downloaded file
				const tempDir = path.join(process.env.PWD || '/directus', 'tmp', 'transcode');
				if (!fs.existsSync(tempDir)) {
					try {
						fs.mkdirSync(tempDir, { recursive: true, mode: 0o755 });
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.error(`[transcode-video-operation] (${filename}) Failed to create temp directory ${tempDir}: ${errorMessage}`);
						// If it's a permission error and the directory exists (race condition), continue
						if (errorMessage.includes('EACCES') || errorMessage.includes('permission denied')) {
							if (fs.existsSync(tempDir)) {
								logger.warn(`[transcode-video-operation] (${filename}) Temp directory exists but has permission issues. Continuing anyway.`);
							} else {
								return {
									error: `Permission denied creating temp directory ${tempDir}. Please ensure the directory exists on the host with proper permissions (chmod 755) or run: mkdir -p ./tmp && chmod 755 ./tmp`
								};
							}
						} else {
							return {
								error: `Failed to create temp directory ${tempDir}: ${errorMessage}`
							};
						}
					}
				}

				// Download file to temporary location using HTTP request to Directus assets endpoint
				// This works for all storage types (local, S3, GCS, etc.)
				const tempFilePath = path.join(tempDir, `${fileId}_${fileObject.filename_disk}`);
				tempSourceFile = tempFilePath;

				// baseUrl is resolved at the top of the handler

				if (!fileId || typeof fileId !== 'string' || fileId.trim() === '') {
					logger.error(`[transcode-video-operation] (${filename}) Invalid fileId: ${fileId}`);
					return {
						error: `Invalid file ID: ${fileId}`
					};
				}

				const assetUrl = `${baseUrl}/assets/${fileId}`;

				logger.info(`[transcode-video-operation] (${filename}) Source file is in cloud storage (${sourceStorageDriver}), downloading to temporary location...`);

				await new Promise<void>((resolve, reject) => {
					// Validate URL before making request
					try {
						new URL(assetUrl);
					} catch (urlError) {
						reject(new Error(`Invalid asset URL: ${assetUrl}. Error: ${urlError instanceof Error ? urlError.message : String(urlError)}`));
						return;
					}

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

				filePath = tempSourceFile;
				needsCleanup = true;
				logger.info(`[transcode-video-operation] (${filename}) Source file downloaded to: ${filePath}`);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				logger.error(`[transcode-video-operation] (${filename}) Error downloading source file from cloud storage: ${errorMessage}`);
				if (errorStack) {
					logger.error(`[transcode-video-operation] (${filename}) Error stack: ${errorStack}`);
				}
				return {
					error: `Failed to download source file from cloud storage: ${errorMessage}`
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
			// For cloud storage, use the same directory as source file (or temp)
			outputDir = path.dirname(filePath);
			logger.info(`[transcode-video-operation] (${filename}) Target storage is cloud (${targetStorageAdapter}), output directory: ${outputDir}`);
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

		if (process_mode === 'all' || process_mode === 'hls_only') {
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
				exec(`ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of json ${filePath}`,
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

			// Filter out qualities that would require upscaling
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
				logger.info(`[transcode-video-operation] (${filename}) Filtered out ${qualitiesBeforeFilter - qualitiesRaw.length} quality level(s) that would require upscaling`);
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

			// --- Upload HLS Encryption Key ---
			if (fs.existsSync(keyFileLocalPath)) {
				try {
					logger.info(`[transcode-video-operation] (${filename}) Uploading HLS encryption key: ${keyFilename}`);
					const keyId = await uploadFileToDirectus(keyFileLocalPath, targetFolderId, {
						mimetype: 'application/octet-stream'
					});
					fileIdMap[keyFilename] = keyId;
					uploadedFiles.push({ filename_disk: keyFilename, id: keyId });
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
			const useFilenameDisk = playlist_reference_type === 'filename_disk';
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
		} else if (process_mode === 'audio_only') {
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
				if (process_mode === 'audio_only') {
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
				(process_mode === 'all' && generate_speech2text) ||
				(process_mode === 'transcription_only' && !isAudioInput);

			if (shouldSaveAudioPermanently) {
				try {
					const audioFilename = `${filename}_audio.mp3`;
					const permanentAudioPath = path.join(outputDir, audioFilename);

					// Copy/move temporary audio to outputDir
					if (tempAudioPath !== permanentAudioPath) {
						fs.copyFileSync(tempAudioPath, permanentAudioPath);
					}
					logger.info(`[transcode-video-operation] (${filename}) Permanent audio file saved locally: ${permanentAudioPath}`);

					// Upload audio to Directus
					logger.info(`[transcode-video-operation] (${filename}) Uploading permanent audio to Directus folder...`);
					audioId = await uploadFileToDirectus(permanentAudioPath, targetFolderId, {
						mimetype: 'audio/mpeg'
					});

					if (audioId) {
						fileIdMap[audioFilename] = audioId;
						uploadedFiles.push({ filename_disk: audioFilename, id: audioId });
						logger.info(`[transcode-video-operation] (${filename}) Permanent audio uploaded successfully. ID: ${audioId}`);
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
				const allTranscodedFiles = readFiles(outputDir);
				for (const fileToDelete of allTranscodedFiles) {
					// Don't delete the source file
					if (fileToDelete === fileObject.filename_disk) {
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
