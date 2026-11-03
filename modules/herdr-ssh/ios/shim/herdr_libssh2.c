#include "libssh2_priv.h"
#include "transport.h"
#include "herdr_libssh2.h"

int herdr_libssh2_pump(LIBSSH2_SESSION *session)
{
    int i;
    for(i = 0; i < 1024; i++) {
        int rc = _libssh2_transport_read(session);
        if(rc < 0)
            return rc;
    }
    return LIBSSH2_ERROR_EAGAIN;
}

int herdr_libssh2_channel_flush_owned(LIBSSH2_CHANNEL *channel)
{
    LIBSSH2_SESSION *session = channel->session;
    struct transportpacket *p = &session->packet;
    const unsigned char *start = (const unsigned char *)channel;
    const unsigned char *end = start + sizeof(*channel);
    int owned;

    if(!p->olen)
        return 0;
    owned = (p->odata >= start && p->odata < end) ||
            (channel->process_packet && p->odata == channel->process_packet);
    if(!owned)
        return 0;
    return _libssh2_transport_send(session, p->odata, p->olen, NULL, 0);
}

int herdr_libssh2_send_pending(LIBSSH2_SESSION *session)
{
    return session->packet.olen ? 1 : 0;
}

void herdr_libssh2_mark_disconnected(LIBSSH2_SESSION *session)
{
    session->socket_state = LIBSSH2_SOCKET_DISCONNECTED;
}
