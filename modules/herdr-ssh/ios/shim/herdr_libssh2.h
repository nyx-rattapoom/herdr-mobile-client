#ifndef HERDR_LIBSSH2_H
#define HERDR_LIBSSH2_H

#include "libssh2.h"


int herdr_libssh2_pump(LIBSSH2_SESSION *session);

int herdr_libssh2_channel_flush_owned(LIBSSH2_CHANNEL *channel);

int herdr_libssh2_send_pending(LIBSSH2_SESSION *session);

void herdr_libssh2_mark_disconnected(LIBSSH2_SESSION *session);

#endif
