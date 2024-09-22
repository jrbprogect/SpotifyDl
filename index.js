const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const SpotifyWebApi = require('spotify-web-api-node');
const archiver = require('archiver');

const app = express();
const port = process.env.PORT || 3000;

const spotifyApi = new SpotifyWebApi({
    clientId: '94b01c61b476499e8df68ae6aef43c59',
    clientSecret: '59bc29096c234c16acc35493e2786fa8'
});

function isValidSpotifyUrl(url) {
    const spotifyUrlPattern = /^(https:\/\/)?(open\.spotify\.com\/)(album|playlist|track)\/([a-zA-Z0-9]+)(\?.*)?$/;
    return spotifyUrlPattern.test(url);
}

async function getAlbumTracks(albumId) {
    try {
        const data = await spotifyApi.getAlbumTracks(albumId);
        return data.body.items.map(item => ({
            name: item.name,
            url: item.external_urls.spotify
        }));
    } catch (error) {
        console.error('Error fetching album tracks:', error);
        throw new Error('Failed to fetch album tracks.');
    }
}

async function getPlaylistTracks(playlistId) {
    try {
        const data = await spotifyApi.getPlaylistTracks(playlistId);
        return data.body.items.map(item => ({
            name: item.track.name,
            url: item.track.external_urls.spotify
        }));
    } catch (error) {
        console.error('Error fetching playlist tracks:', error);
        throw new Error('Failed to fetch playlist tracks.');
    }
}

async function downloadTrack(trackUrl, outputPath) {
    const apiUrl = `https://tools.betabotz.eu.org/tools/spotifydl?url=${encodeURIComponent(trackUrl)}`;
    const response = await axios.get(apiUrl);

    if (response.data.status !== 200) {
        throw new Error('Failed to fetch track download URL.');
    }

    const downloadUrl = response.data.result;

    const trackResponse = await axios.get(downloadUrl, { responseType: 'stream' });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        trackResponse.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function createZipFile(trackPaths, zipFilePath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', reject);

        archive.pipe(output);
        trackPaths.forEach(filePath => {
            archive.file(filePath, { name: path.basename(filePath) });
        });
        archive.finalize();
    });
}

async function deleteFiles(directory) {
    try {
        await fs.remove(directory);
    } catch (error) {
        console.error('Error deleting files:', error);
    }
}

app.get('/', (req, res) => {
    res.status(200).json({ status: 'UP', owner: 'JrDev06' });
});

app.get('/spotifydl', async (req, res) => {
    const { url, search } = req.query;

    if (search) {
        try {
            await spotifyApi.clientCredentialsGrant().then(data => spotifyApi.setAccessToken(data.body['access_token']));
            const searchResult = await spotifyApi.searchTracks(search);

            if (searchResult.body.tracks.items.length === 0) {
                return res.status(404).json({ error: 'Track not found.' });
            }

            const track = searchResult.body.tracks.items[0];
            const trackUrl = track.external_urls.spotify;

            const outputDir = path.join(__dirname, 'downloads', track.id);
            const trackPath = path.join(outputDir, `${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);

            await fs.ensureDir(outputDir);
            await downloadTrack(trackUrl, trackPath);

            const downloadLink = `${req.protocol}://${req.get('host')}/download/${track.id}/${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`;

            res.json({
                owner: 'JrDev06',
                track: {
                    name: track.name,
                    artist: track.artists.map(artist => artist.name).join(', '),
                    album: track.album.name,
                    duration: track.duration_ms,
                    downloadLink
                }
            });

            app.get(`/download/${track.id}/${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`, (req, res) => {
                const filePath = path.join(outputDir, `${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);
                res.download(filePath);
                
                setTimeout(async () => {
                    await deleteFiles(outputDir);
                }, 900000);
            });

        } catch (error) {
            console.error('Error processing search:', error.message);
            res.status(500).json({ error: 'Failed to process the search request.' });
        }

    } else if (url) {
        if (!isValidSpotifyUrl(url)) {
            return res.status(400).json({ error: 'Invalid Spotify URL.' });
        }

        const urlMatch = url.match(/(album|playlist|track)\/([a-zA-Z0-9]+)/);
        if (!urlMatch) {
            return res.status(400).json({ error: 'Invalid Spotify URL format.' });
        }

        const type = urlMatch[1];
        const id = urlMatch[2];
        const outputDir = path.join(__dirname, 'downloads', id);
        const isSingleTrack = type === 'track';

        try {
            await spotifyApi.clientCredentialsGrant().then(data => spotifyApi.setAccessToken(data.body['access_token']));

            let tracks;
            let name;

            if (type === 'album') {
                const albumDetails = await spotifyApi.getAlbum(id);
                name = albumDetails.body.name.replace(/[^a-zA-Z0-9]/g, '_');
                tracks = await getAlbumTracks(id);
            } else if (type === 'playlist') {
                const playlistDetails = await spotifyApi.getPlaylist(id);
                name = playlistDetails.body.name.replace(/[^a-zA-Z0-9]/g, '_');
                tracks = await getPlaylistTracks(id);
            } else if (type === 'track') {
                const trackDetails = await spotifyApi.getTrack(id);
                name = trackDetails.body.name.replace(/[^a-zA-Z0-9]/g, '_');
                tracks = [{ name: trackDetails.body.name, url: trackDetails.body.external_urls.spotify }];
            }

            await fs.ensureDir(outputDir);

            const trackPaths = [];
            const failedTracks = [];

            for (const track of tracks) {
                const trackPath = path.join(outputDir, `${track.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);
                try {
                    await downloadTrack(track.url, trackPath);
                    trackPaths.push(trackPath);
                } catch (error) {
                    console.error(`Failed to download track ${track.name}:`, error.message);
                    failedTracks.push(track.name);
                }
            }

            let downloadLink;
            if (!isSingleTrack) {
                const zipFilePath = path.join(outputDir, `${name}.zip`);
                await createZipFile(trackPaths, zipFilePath);
                downloadLink = `${req.protocol}://${req.get('host')}/download/${id}/${name}.zip`;
            } else {
                const singleTrackPath = path.join(outputDir, `${name}.mp3`);
                downloadLink = `${req.protocol}://${req.get('host')}/download/${id}/${name}.mp3`;
            }

            res.json({
                owner: 'JrDev06',
                type,
                name,
                tracks: tracks.map(track => track.name),
                failedTracks,
                downloadLink
            });

            app.get(`/download/${id}/${name}.zip`, (req, res) => {
                const filePath = path.join(outputDir, `${name}.zip`);
                res.download(filePath);
                
                setTimeout(async () => {
                    await deleteFiles(outputDir);
                }, 900000);
            });

            app.get(`/download/${id}/${name}.mp3`, (req, res) => {
                const filePath = path.join(outputDir, `${name}.mp3`);
                res.download(filePath);

                setTimeout(async () => {
                    await deleteFiles(outputDir);
                }, 900000);
            });

        } catch (error) {
            console.error('Error processing download:', error.message);
            res.status(500).json({ error: 'Failed to process the download request.' });
        }
    } else {
        res.status(400).json({ error: 'No URL or search term provided.' });
    }
});

async function deleteFiles(directory) {
    try {
        await fs.remove(directory);
        console.log(`Deleted files in directory: ${directory}`);
    } catch (error) {
        console.error(`Error deleting files in ${directory}:`, error);
    }
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

    
