'use strict';

const S3 = require('@aws-sdk/client-s3');
const mime = require('mime');
const uuid = require('uuid').v4;
const fs = require('fs');
const request = require('request');
const path = require('path');

const winston = require.main.require('winston');
const nconf = require.main.require('nconf');
const gm = require('gm');

const im = gm.subClass({ imageMagick: true });
const meta = require.main.require('./src/meta');
const db = require.main.require('./src/database');
const routeHelpers = require.main.require('./src/routes/helpers');
const fileModule = require.main.require('./src/file');

const Package = require('./package.json');

const PLUGIN_ID = '@h1deya/nodebb-plugin-s3-uploads'

const isDebug = process.env.NODE_ENV === 'development';
function log(...args) {
	if (isDebug) {
		console.log('\x1b[36m[S3 Uploads]\x1b[0m', ...args);
	}
}

const plugin = module.exports;

const settings = {
	// accessKeyId: false,
	accessKeyId: process.env.AWS_ACCESS_KEY_ID || false,
	// secretAccessKey: false,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || false,
	region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
	bucket: process.env.S3_UPLOADS_BUCKET || undefined,
	endpoint: process.env.S3_UPLOADS_ENDPOINT || 's3.amazonaws.com',
	host: process.env.S3_UPLOADS_HOST || 's3.amazonaws.com',
	path: process.env.S3_UPLOADS_PATH || undefined,
	// Required for Cloudflare R2?
	// forcePathStyle: process.env.S3_FORCE_PATH_STYLE  === 'true' || false,
};

log('settings', settings);

let accessKeyIdFromDb = false;
// eslint-disable-next-line no-unused-vars
let secretAccessKeyFromDb = false;

function fetchSettings(callback) {
	db.getObjectFields(Package.name, Object.keys(settings), (err, newSettings) => {
		if (err) {
			winston.error(err.message);
			if (typeof callback === 'function') {
				callback(err);
			}
			return;
		}

		log('fetchSettings: newSettings', newSettings);

		accessKeyIdFromDb = false;
		secretAccessKeyFromDb = false;

		// if (newSettings.accessKeyId) {
		// 	settings.accessKeyId = newSettings.accessKeyId;
		// 	accessKeyIdFromDb = true;
		// } else {
		// 	settings.accessKeyId = false;
		// }

		// if (newSettings.secretAccessKey) {
		// 	settings.secretAccessKey = newSettings.secretAccessKey;
		// 	secretAccessKeyFromDb = false;
		// } else {
		// 	settings.secretAccessKey = false;
		// }

		if (!newSettings.bucket) {
			settings.bucket = process.env.S3_UPLOADS_BUCKET || '';
		} else {
			settings.bucket = newSettings.bucket;
		}

		if (!newSettings.host) {
			settings.host = process.env.S3_UPLOADS_HOST || '';
		} else {
			settings.host = newSettings.host;
		}

		if (!newSettings.endpoint) {
			settings.endpoint = process.env.S3_UPLOADS_ENDPOINT || '';
		} else {
			settings.endpoint = newSettings.endpoint;
		}

		if (!newSettings.path) {
			settings.path = process.env.S3_UPLOADS_PATH || '';
		} else {
			settings.path = newSettings.path;
		}

		if (!newSettings.region) {
			settings.region = process.env.AWS_DEFAULT_REGION || '';
		} else {
			settings.region = newSettings.region;
		}

		log('fetchSettings: settings', settings);

		if (typeof callback === 'function') {
			callback();
		}
	});
}

function constructS3() {
	log('constructS3', settings);

	return new S3.S3Client({
		region: settings.region,
		endpoint: settings.endpoint,
		credentials: {
			accessKeyId: settings.accessKeyId,
			secretAccessKey: settings.secretAccessKey,
		},
		// forcePathStyle: settings.forcePathStyle, // Required for R2?
	});
}

function makeError(err) {
	if (err instanceof Error) {
		err.message = `${Package.name} :: ${err.message}`;
	} else {
		err = new Error(`${Package.name} :: ${err}`);
	}

	winston.error(err.message);
	return err;
}

plugin.activate = function (data) {
	log('activate', data);
	if (data.id === PLUGIN_ID) {
		fetchSettings();
	}
};

plugin.deactivate = function (data) {
	log('deactivate', data);
	if (data.id === PLUGIN_ID) {
		// pass
	}
};

plugin.load = function (params, callback) {
	fetchSettings((err) => {
		if (err) {
			winston.error(err.message);
			return callback(err);
		}
		const adminRoute = '/admin/plugins/s3-uploads';
		const { router, middleware } = params;
		routeHelpers.setupAdminPageRoute(router, adminRoute, renderAdmin);

		params.router.post(`/api${adminRoute}/s3settings`, middleware.applyCSRF, s3settings);
		params.router.post(`/api${adminRoute}/credentials`, middleware.applyCSRF, credentials);

		callback();
	});
};

function renderAdmin(req, res) {
	let forumPath = nconf.get('url');
	if (forumPath.split('').reverse()[0] !== '/') {
		forumPath += '/';
	}
	const data = {
		title: 'S3 Uploads',
		bucket: settings.bucket,
		host: settings.host,
		endpoint: settings.endpoint,
		path: settings.path,
		forumPath: forumPath,
		region: settings.region,
		// accessKeyId: (accessKeyIdFromDb && settings.accessKeyId) || '',
		accessKeyId: settings.accessKeyId || '',
		// secretAccessKey: (accessKeyIdFromDb && settings.secretAccessKey) || '',
		secretAccessKey: settings.secretAccessKey || '',
	};

	res.render('admin/plugins/s3-uploads', data);
}

function s3settings(req, res, next) {
	const data = req.body;
	const newSettings = {
		bucket: data.bucket || '',
		endpoint: data.endpoint || '',
		host: data.host || '',
		path: data.path || '',
		region: data.region || '',
	};

	saveSettings(newSettings, res, next);
}

function credentials(req, res, next) {
	const data = req.body;
	const newSettings = {
		accessKeyId: data.accessKeyId || '',
		secretAccessKey: data.secretAccessKey || '',
	};

	saveSettings(newSettings, res, next);
}

function saveSettings(settings, res, next) {
	db.setObject(Package.name, settings, (err) => {
		if (err) {
			return next(makeError(err));
		}

		fetchSettings();
		res.json('Saved!');
	});
}

function isExtensionAllowed(filePath, allowed) {
	const extension = path.extname(filePath).toLowerCase();
	return !(allowed.length > 0 && (!extension || extension === '.' || !allowed.includes(extension)));
}

plugin.uploadImage = function (data, callback) {
	const { image } = data;

	if (!image) {
		winston.error('invalid image');
		return callback(new Error('invalid image'));
	}

	// check filesize vs. settings
	if (image.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error(`error:file-too-big, ${meta.config.maximumFileSize}`);
		return callback(new Error(`[[error:file-too-big, ${meta.config.maximumFileSize}]]`));
	}

	const type = image.url ? 'url' : 'file';
	const allowed = fileModule.allowedExtensions();

	if (type === 'file') {
		if (!image.path) {
			return callback(new Error('invalid image path'));
		}

		if (!isExtensionAllowed(image.path, allowed)) {
			return callback(new Error(`[[error:invalid-file-type, ${allowed.join('&#44; ')}]]`));
		}

		fs.readFile(image.path, (err, buffer) => {
			uploadToS3(image.name, err, buffer, callback);
		});
	} else {
		if (!isExtensionAllowed(image.url, allowed)) {
			return callback(new Error(`[[error:invalid-file-type, ${allowed.join('&#44; ')}]]`));
		}

		const filename = image.url.split('/').pop();

		const imageDimension = parseInt(meta.config.profileImageDimension, 10) || 128;

		// Resize image.
		im(request(image.url), filename)
			.resize(`${imageDimension}^`, `${imageDimension}^`)
			.stream((err, stdout) => {
				if (err) {
					return callback(makeError(err));
				}

				// This is sort of a hack - We"re going to stream the gm output to a buffer and then upload.
				// See https://github.com/aws/aws-sdk-js/issues/94
				let buf = Buffer.alloc(0);
				stdout.on('data', (d) => {
					buf = Buffer.concat([buf, d]);
				});
				stdout.on('end', () => {
					uploadToS3(filename, null, buf, callback);
				});
			});
	}
};

plugin.uploadFile = function (data, callback) {
	const { file } = data;

	if (!file) {
		return callback(new Error('invalid file'));
	}

	if (!file.path) {
		return callback(new Error('invalid file path'));
	}

	// check filesize vs. settings
	if (file.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
		winston.error(`error:file-too-big, ${meta.config.maximumFileSize}`);
		return callback(new Error(`[[error:file-too-big, ${meta.config.maximumFileSize}]]`));
	}

	const allowed = fileModule.allowedExtensions();
	if (!isExtensionAllowed(file.path, allowed)) {
		return callback(new Error(`[[error:invalid-file-type, ${allowed.join('&#44; ')}]]`));
	}

	fs.readFile(file.path, (err, buffer) => {
		uploadToS3(file.name, err, buffer, callback);
	});
};

async function uploadToS3(filename, err, buffer, callback) {
	if (err) {
		return callback(makeError(err));
	}

	log('uploadToS3', filename)

	let s3Path;
	if (settings.path && settings.path.length > 0) {
		s3Path = settings.path;

		if (!s3Path.match(/\/$/)) {
			// Add trailing slash
			s3Path += '/';
		}
	} else {
		s3Path = '/';
	}

	const s3KeyPath = s3Path.replace(/^\//, ''); // S3 Key Path should not start with slash.

	const params = {
		Bucket: settings.bucket,
		ACL: 'public-read',
		Key: s3KeyPath + uuid() + path.extname(filename),
		Body: buffer,
		ContentLength: buffer.length,
		ContentType: mime.getType(filename),
	};

	try {
		const s3Client = constructS3();

		log('uploadToS3: s3Client.send: params', params)

		await s3Client.send(new S3.PutObjectCommand(params));

		// amazon has https enabled, we use it by default
		let host = `https://${params.Bucket}.s3.amazonaws.com`;
		if (settings.host && settings.host.length > 0) {
			host = settings.host;
			// host must start with http or https
			if (!host.startsWith('http')) {
				host = `http://${host}`;
			}
		}

		callback(null, {
			name: filename,
			url: `${host}/${params.Key}`,
		});
	} catch (err) {
		callback(makeError(err));
	}
}

plugin.admin = {};

plugin.admin.menu = function (custom_header, callback) {
	custom_header.plugins.push({
		route: '/plugins/s3-uploads',
		icon: 'fa-envelope-o',
		name: 'S3 Uploads',
	});

	callback(null, custom_header);
};
