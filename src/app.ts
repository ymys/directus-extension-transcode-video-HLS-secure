export default {
	id: 'transcode-video-operation',
	name: 'Transcode Video Operation',
	icon: 'extension',
	description: 'Transcode input file to HLS streams with multiple quality levels',
	overview: ({ file, folder_id, process_mode }: { file?: any; folder_id?: string; process_mode?: string }) => [
		{
			label: 'File',
			text: file,
		},
		{
			label: 'Folder ID',
			text: folder_id,
		},
		{
			label: 'Process Mode',
			text: process_mode || 'all',
		}
	],
	options: [
		{
			field: 'file',
			name: 'File',
			type: 'text',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'File UUID / File Object',
				},
				note: 'Input file UUID or file object.',
			},
			schema: {
				required: true,
			},
		},
		{
			field: 'folder_id',
			name: 'Folder',
			type: 'uuid',
			meta: {
				width: 'half',
				interface: 'system-folder',
				note: 'Root folder for storing all transcoded files. If not provided, a new folder will be created.',
			},
			schema: {
				required: false,
			},
		},
		{
			field: 'process_mode',
			name: 'Process Mode',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{ text: 'Full Transcode & Transcription (default)', value: 'all' },
						{ text: 'Process HLS and mono audio (mp3 mono)', value: 'hls_and_audio' },
						{ text: 'Process only HLS from existing video', value: 'hls_only' },
						{ text: 'Process to mono audio only (mp3 mono) from existing video', value: 'audio_only' },
						{ text: 'Process to transcript only from existing mp3 mono', value: 'transcription_only' }
					]
				},
				note: 'Select operational mode. Options range from HLS-only or audio-only extraction to transcription-only from mono audio.'
			},
			schema: {
				default_value: 'all'
			}
		},
		{
			field: 'keyBaseUrl',
			name: 'Key Base URL',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'https://cdn.example.com/keys',
				},
				note: 'Optional. The public URL prefix for the encryption key. If left blank, a relative path will be used.',
				conditions: [
					{
						name: 'Hide HLS settings',
						rule: {
							process_mode: {
								_in: ['audio_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false,
			},
		},
		{
			field: 'playlist_reference_type',
			name: 'Playlist Reference Type',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{ text: 'Filename Disk (standard HLS / CDN compatible, default)', value: 'filename_disk' },
						{ text: 'Directus File IDs (legacy /assets/:uuid)', value: 'id' }
					]
				},
				note: 'How playlists reference segments: "Filename Disk" uses actual filenames (e.g. video_240p_000.ts) compatible with CDN/Cloudflare R2 and standard HLS players. "Directus File IDs" uses Directus UUIDs.',
				conditions: [
					{
						name: 'Hide HLS settings',
						rule: {
							process_mode: {
								_in: ['audio_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 'filename_disk'
			}
		},
		{
			field: 'qualities',
			name: 'Quality Levels',
			type: 'json',
			meta: {
				interface: 'select-multiple-checkbox',
				options: {
					choices: [
						{ text: '240p', value: '240p' },
						{ text: '480p', value: '480p' },
						{ text: '720p', value: '720p' },
						{ text: '1080p', value: '1080p' },
						{ text: '4K', value: '2160p' }
					]
				},
				note: 'Select the quality levels to transcode the video to. The maximum quality level depends on the input video (no upscaling).',
				conditions: [
					{
						name: 'Hide HLS settings',
						rule: {
							process_mode: {
								_in: ['audio_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: ['240p', '480p', '720p', '1080p', '2160p']
			}
		},
		{
			field: 'prevent_upscale',
			name: 'Prevent Upscaling',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'If enabled (default), automatically skips quality levels higher than input video height (e.g. skips 480p/720p/1080p if source video is 360p). Turn OFF to force upscale to all selected resolutions.',
				conditions: [
					{
						name: 'Hide HLS settings',
						rule: {
							process_mode: {
								_in: ['audio_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: true
			}
		},
		{
			field: 'storage_adapter',
			name: 'Storage Adapter',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-radio',
				options: {
					choices: [
						{ text: 'Environment Configuration (First One)', value: 'default' },
						{ text: 'Same as Source File', value: 'source' },
						{ text: 'Cloudflare R2 Storage (STORAGE_R2)', value: 'r2' },
						{ text: 'Other', value: 'custom' }
					]
				},
				note: 'Select the storage adapter where transcoded HLS files physically should be stored.'
			},
			schema: {
				default_value: 'default'
			}
		},
		{
			field: 'target_storage',
			name: 'Target Storage Location',
			type: 'text',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'e.g., local, s3, gcs, r2'
				},
				note: 'Specify the storage location name (must match one of your configured STORAGE_LOCATIONS)',
				conditions: [
					{
						name: 'Hide when storage_adapter is not custom',
						rule: {
							_or: [
								{
									storage_adapter: {
										_eq: 'default'
									}
								},
								{
									storage_adapter: {
										_eq: 'source'
									}
								},
								{
									storage_adapter: {
										_eq: 'r2'
									}
								},
								{
									storage_adapter: {
										_null: true
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'key_storage_adapter',
			name: 'Key Storage Location',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-radio',
				options: {
					choices: [
						{ text: 'Save Key in Directus (Local/Default Storage)', value: 'directus' },
						{ text: 'Same as HLS Target Storage', value: 'target' },
						{ text: 'Other Custom Location', value: 'custom' }
					]
				},
				note: 'Where the HLS AES-128 encryption key (.key) should be stored. Keeping key in Directus ensures playback remains secured when HLS files are served from Cloudflare R2.'
			},
			schema: {
				default_value: 'directus'
			}
		},
		{
			field: 'key_target_storage',
			name: 'Key Custom Storage Location',
			type: 'text',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'e.g., local, s3'
				},
				note: 'Specify the custom storage location name for the encryption key.',
				conditions: [
					{
						name: 'Hide when key_storage_adapter is not custom',
						rule: {
							_or: [
								{
									key_storage_adapter: {
										_eq: 'directus'
									}
								},
								{
									key_storage_adapter: {
										_eq: 'target'
									}
								},
								{
									key_storage_adapter: {
										_null: true
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'audio_storage_adapter',
			name: 'Audio Storage Location',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-radio',
				options: {
					choices: [
						{ text: 'Save Audio in Directus (Local/Default Storage)', value: 'directus' },
						{ text: 'Same as HLS Target Storage', value: 'target' },
						{ text: 'Other Custom Location', value: 'custom' }
					]
				},
				note: 'Where generated mp3 mono audio files should be stored.',
				conditions: [
					{
						name: 'Hide when audio extraction is not run',
						rule: {
							process_mode: {
								_in: ['hls_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 'directus'
			}
		},
		{
			field: 'audio_target_storage',
			name: 'Audio Custom Storage Location',
			type: 'text',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'e.g., local, s3, r2'
				},
				note: 'Specify the custom storage location name for generated mp3 audio files.',
				conditions: [
					{
						name: 'Hide when audio_storage_adapter is not custom',
						rule: {
							_or: [
								{ audio_storage_adapter: { _eq: 'directus' } },
								{ audio_storage_adapter: { _eq: 'target' } },
								{ audio_storage_adapter: { _null: true } }
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'delete_source_file',
			name: 'Delete Original Source File',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'If enabled, the original source video file (.mp4) will be deleted from Directus database and storage after transcoding completes. Default: disabled (leave source file intact).'
			},
			schema: {
				default_value: false
			}
		},
		{
			field: 'delete_existing_hls',
			name: 'Delete Existing HLS Files',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'If enabled, automatically deletes all existing HLS files (playlists, segments, keys) from Directus database and storage before generating fresh secured HLS files.',
				conditions: [
					{
						name: 'Hide when process_mode is audio or transcription only',
						rule: {
							process_mode: {
								_in: ['audio_only', 'transcription_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: false
			}
		},
		{
			field: 'performance_divider',
			name: 'Performance Settings',
			type: 'alias',
			meta: {
				width: 'full',
				interface: 'presentation-divider',
				special: ['alias', 'no-data'],
				options: {
					title: 'Performance Settings'
				},
				conditions: [
					{
						name: 'Hide performance settings',
						rule: {
							process_mode: {
								_eq: 'transcription_only'
							}
						},
						hidden: true
					}
				]
			},
			schema: {}
		},
		{
			field: 'threads',
			name: 'Thread Count',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: '1',
					min: 0,
					step: 1
				},
				note: 'Number of threads to use for transcoding. Use 1 for single-threaded, or 0 to use all available CPU cores. Default: 1',
				conditions: [
					{
						name: 'Hide performance settings',
						rule: {
							process_mode: {
								_eq: 'transcription_only'
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 1
			}
		},
		{
			field: 'nice',
			name: 'Process Priority',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: '19',
					min: 0,
					max: 19,
					step: 1
				},
				note: 'Process priority (nice value) for transcoding. Range: 0 (highest) to 19 (lowest). Keep priority low when transcoding kills your system.',
				conditions: [
					{
						name: 'Hide performance settings',
						rule: {
							process_mode: {
								_eq: 'transcription_only'
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 19,
				required: false
			}
		},
		{
			field: 'captions_divider',
			name: 'AI Caption Settings',
			type: 'alias',
			meta: {
				width: 'full',
				interface: 'presentation-divider',
				special: ['alias', 'no-data'],
				options: {
					title: 'AI Caption Settings'
				},
				conditions: [
					{
						name: 'Hide when not in all mode',
						rule: {
							process_mode: {
								_neq: 'all'
							}
						},
						hidden: true
					}
				]
			},
			schema: {}
		},
		{
			field: 'generate_captions',
			name: 'Generate Captions (AI)',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'Automatically generate subtitles/captions using AI Whisper model.',
				conditions: [
					{
						name: 'Hide when not in all mode',
						rule: {
							process_mode: {
								_neq: 'all'
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: false
			}
		},
		{
			field: 'caption_language',
			name: 'Caption Language',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'e.g. en, es, id (blank for auto)'
				},
				note: 'ISO 639-1 code of language. Leave blank for Whisper auto-detection.',
				conditions: [
					{
						name: 'Hide captions settings',
						rule: {
							_or: [
								{
									process_mode: {
										_neq: 'all'
									}
								},
								{
									generate_captions: {
										_eq: false
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'caption_endpoint',
			name: 'API Endpoint Override',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'https://...'
				},
				note: 'Optional override for the AI Whisper API Endpoint. If left blank, environment default will be used.',
				conditions: [
					{
						name: 'Hide captions settings',
						rule: {
							_or: [
								{
									process_mode: {
										_neq: 'all'
									}
								},
								{
									generate_captions: {
										_eq: false
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'caption_api_key',
			name: 'API Key Override',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input-password',
				note: 'Optional override for the AI Whisper API key.',
				conditions: [
					{
						name: 'Hide captions settings',
						rule: {
							_or: [
								{
									process_mode: {
										_neq: 'all'
									}
								},
								{
									generate_captions: {
										_eq: false
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'caption_api_type',
			name: 'API Authentication Type',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'select-dropdown',
				options: {
					choices: [
						{ text: 'Use environment configuration (default)', value: 'env' },
						{ text: 'OpenAI (Authorization: Bearer header)', value: 'openai' },
						{ text: 'Azure OpenAI (api-key header)', value: 'azure' }
					]
				},
				note: 'Authentication header format strategy.',
				conditions: [
					{
						name: 'Hide captions settings',
						rule: {
							_or: [
								{
									process_mode: {
										_neq: 'all'
									}
								},
								{
									generate_captions: {
										_eq: false
									}
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 'env'
			}
		},
		{
			field: 'speech2text_divider',
			name: 'AI Speech2Text Settings',
			type: 'alias',
			meta: {
				width: 'full',
				interface: 'presentation-divider',
				special: ['alias', 'no-data'],
				options: {
					title: 'AI Speech2Text Settings'
				},
				conditions: [
					{
						name: 'Hide S2T settings',
						rule: {
							process_mode: {
								_in: ['hls_only', 'audio_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {}
		},
		{
			field: 'generate_speech2text',
			name: 'Generate Speech2Text (Azure Batch)',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'Extract and permanently save audio, then generate SRT subtitles using Azure Speech-to-Text batch transcription.',
				conditions: [
					{
						name: 'Hide S2T settings',
						rule: {
							process_mode: {
								_in: ['hls_only', 'audio_only']
							}
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: false
			}
		},
		{
			field: 'speech2text_locale',
			name: 'Speech2Text Locale',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'e.g. id-ID, en-US (default: id-ID)'
				},
				note: 'The locale/language code for transcription.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 'id-ID',
				required: false
			}
		},
		{
			field: 'speech2text_endpoint',
			name: 'Speech2Text Endpoint Override',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: 'https://swedencentral.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions'
				},
				note: 'Optional. URL for the Azure Speech-to-Text batch transcription API.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'speech2text_subscription_key',
			name: 'Speech2Text Subscription Key',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input-password',
				note: 'Optional override for the Azure subscription API key (Ocp-Apim-Subscription-Key). If left blank, environment variable SPEECH2TEXT_SUBSCRIPTION_KEY is used.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'speech2text_access_token',
			name: 'Speech2Text Directus Access Token',
			type: 'string',
			meta: {
				width: 'half',
				interface: 'input-password',
				note: 'Optional. Directus static access token to append to the audio URL, allowing Azure to download private assets.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'speech2text_diarization',
			name: 'Speech2Text Diarization',
			type: 'boolean',
			meta: {
				width: 'half',
				interface: 'boolean',
				note: 'Identify different speakers (diarization).',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: true
			}
		},
		{
			field: 'speech2text_speaker_map',
			name: 'Speech2Text Speaker Map',
			type: 'json',
			meta: {
				width: 'half',
				interface: 'input-code',
				options: {
					language: 'json',
					placeholder: '{\n  "1": "Mursyid Zamxzam",\n  "2": "Pak Mustafa"\n}'
				},
				note: 'Optional. JSON mapping of speaker IDs to names (e.g. {"1": "Mursyid Zamxzam"}). Enclosed in square brackets.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				required: false
			}
		},
		{
			field: 'speech2text_timeout',
			name: 'Speech2Text Timeout (Seconds)',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: '1800',
					min: 60,
					step: 60
				},
				note: 'Maximum time to wait for the Speech2Text transcription to complete, in seconds. Default: 1800 (30 minutes).',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 1800,
				required: false
			}
		},
		{
			field: 'speech2text_poll_interval',
			name: 'Speech2Text Poll Interval (Seconds)',
			type: 'integer',
			meta: {
				width: 'half',
				interface: 'input',
				options: {
					placeholder: '30',
					min: 5,
					step: 5
				},
				note: 'How often to check the transcription status with Azure, in seconds. Default: 30 seconds.',
				conditions: [
					{
						name: 'Hide speech2text settings',
						rule: {
							_or: [
								{
									process_mode: {
										_in: ['hls_only', 'audio_only']
									}
								},
								{
									_and: [
										{
											process_mode: {
												_eq: 'all'
											}
										},
										{
											generate_speech2text: {
												_eq: false
											}
										}
									]
								}
							]
						},
						hidden: true
					}
				]
			},
			schema: {
				default_value: 30,
				required: false
			}
		}
	],
};
