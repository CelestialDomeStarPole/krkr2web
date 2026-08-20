// Streamed Ogg Vorbis decoder for the Web build.
#include "tjsCommHead.h"

#include <algorithm>
#include <limits.h>
#include <string.h>
#include <vorbis/vorbisfile.h>

#include "BinaryStream.h"
#include "DebugIntf.h"
#include "WaveIntf.h"

namespace {

size_t ReadVorbisStream(void *buffer, size_t size, size_t count, void *data_source)
{
	if(size == 0 || count == 0) return 0;
	tTJSBinaryStream *stream = static_cast<tTJSBinaryStream *>(data_source);
	size_t byte_count = count > UINT_MAX / size ? UINT_MAX : size * count;
	byte_count -= byte_count % size;
	try
	{
		return stream->Read(buffer, static_cast<tjs_uint>(byte_count)) / size;
	}
	catch(...)
	{
		return 0;
	}
}

int SeekVorbisStream(void *data_source, ogg_int64_t offset, int whence)
{
	tTJSBinaryStream *stream = static_cast<tTJSBinaryStream *>(data_source);
	int origin;
	ogg_int64_t base;
	try
	{
		switch(whence)
		{
		case SEEK_SET:
			origin = TJS_BS_SEEK_SET;
			base = 0;
			break;
		case SEEK_CUR:
			origin = TJS_BS_SEEK_CUR;
			base = static_cast<ogg_int64_t>(stream->GetPosition());
			break;
		case SEEK_END:
			origin = TJS_BS_SEEK_END;
			base = static_cast<ogg_int64_t>(stream->GetSize());
			break;
		default:
			return -1;
		}
		if((offset > 0 && base > LLONG_MAX - offset) ||
			(offset < 0 && offset < -base)) return -1;
		ogg_int64_t target = base + offset;
		if(target < 0) return -1;
		return stream->Seek(offset, origin) == static_cast<tjs_uint64>(target) ? 0 : -1;
	}
	catch(...)
	{
		return -1;
	}
}

long TellVorbisStream(void *data_source)
{
	try
	{
		tjs_uint64 position = static_cast<tTJSBinaryStream *>(data_source)->GetPosition();
		return position <= static_cast<tjs_uint64>(LONG_MAX) ? static_cast<long>(position) : -1;
	}
	catch(...)
	{
		return -1;
	}
}

int CloseVorbisStream(void *data_source)
{
	try
	{
		static_cast<tTJSBinaryStream *>(data_source)->Destruct();
		return 0;
	}
	catch(...)
	{
		return -1;
	}
}

const ov_callbacks VorbisCallbacks = {
	ReadVorbisStream,
	SeekVorbisStream,
	CloseVorbisStream,
	TellVorbisStream
};

class tTVPOggVorbisDecoder : public tTVPWaveDecoder
{
	OggVorbis_File File;
	tTVPWaveFormat Format;
	bool Opened;
	bool Ended;

	tTVPOggVorbisDecoder() : Opened(false), Ended(false)
	{
		memset(&File, 0, sizeof(File));
		memset(&Format, 0, sizeof(Format));
	}

public:
	static tTVPOggVorbisDecoder * Open(const ttstr &storage_name)
	{
		tTJSBinaryStream *stream = TVPCreateBinaryStreamForRead(storage_name, TJS_W(""));
		tTVPOggVorbisDecoder *decoder = new tTVPOggVorbisDecoder();
		int result = ov_open_callbacks(stream, &decoder->File, NULL, 0, VorbisCallbacks);
		if(result != 0)
		{
			stream->Destruct();
			delete decoder;
			return NULL;
		}

		decoder->Opened = true;
		vorbis_info *info = ov_info(&decoder->File, -1);
		if(!info || info->channels <= 0 || info->rate <= 0)
		{
			delete decoder;
			return NULL;
		}

		ogg_int64_t total_samples = ov_pcm_total(&decoder->File, -1);
		decoder->Format.SamplesPerSec = static_cast<tjs_uint>(info->rate);
		decoder->Format.Channels = static_cast<tjs_uint>(info->channels);
		decoder->Format.BitsPerSample = 16;
		decoder->Format.BytesPerSample = 2;
		decoder->Format.TotalSamples = total_samples > 0 ? static_cast<tjs_uint64>(total_samples) : 0;
		decoder->Format.TotalTime = total_samples > 0
			? static_cast<tjs_uint64>(total_samples) * 1000 / static_cast<tjs_uint64>(info->rate)
			: 0;
		decoder->Format.SpeakerConfig = 0;
		decoder->Format.IsFloat = false;
		decoder->Format.Seekable = ov_seekable(&decoder->File) != 0;

		static bool first_open = true;
		if(first_open)
		{
			first_open = false;
			TVPAddLog(TJS_W("KRKR2WEB_VORBIS_STREAMING_READY"));
		}
		return decoder;
	}

	~tTVPOggVorbisDecoder()
	{
		if(Opened) ov_clear(&File);
	}

	void GetFormat(tTVPWaveFormat &format)
	{
		format = Format;
	}

	bool Render(void *buffer, tjs_uint sample_length, tjs_uint &rendered)
	{
		rendered = 0;
		if(Ended || sample_length == 0) return !Ended;

		const size_t frame_bytes = static_cast<size_t>(Format.Channels) * Format.BytesPerSample;
		size_t wanted = static_cast<size_t>(sample_length) * frame_bytes;
		size_t written = 0;
		int holes = 0;
		while(written < wanted)
		{
			int bitstream = 0;
			long chunk = ov_read(&File, static_cast<char *>(buffer) + written,
				static_cast<int>(std::min(wanted - written, static_cast<size_t>(INT_MAX))),
				0, 2, 1, &bitstream);
			if(chunk > 0)
			{
				written += static_cast<size_t>(chunk);
				holes = 0;
			}
			else if(chunk == 0)
			{
				Ended = true;
				break;
			}
			else if(++holes > 8)
			{
				Ended = true;
				break;
			}
		}
		rendered = static_cast<tjs_uint>(written / frame_bytes);
		return !Ended;
	}

	bool SetPosition(tjs_uint64 sample_position)
	{
		if(!Format.Seekable || sample_position > static_cast<tjs_uint64>(LLONG_MAX)) return false;
		if(ov_pcm_seek(&File, static_cast<ogg_int64_t>(sample_position)) != 0) return false;
		Ended = false;
		return true;
	}
};

class tTVPOggVorbisDecoderCreator : public tTVPWaveDecoderCreator
{
public:
	tTVPWaveDecoder * Create(const ttstr &storage_name, const ttstr &extension)
	{
		if(extension != TJS_W(".ogg")) return NULL;
		return tTVPOggVorbisDecoder::Open(storage_name);
	}
};

tTVPOggVorbisDecoderCreator VorbisDecoderCreator;

} // namespace

void TVPRegisterVorbisDecoderCreator()
{
	TVPRegisterWaveDecoderCreator(&VorbisDecoderCreator);
}
