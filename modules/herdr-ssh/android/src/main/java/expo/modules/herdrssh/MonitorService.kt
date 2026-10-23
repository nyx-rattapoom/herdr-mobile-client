package expo.modules.herdrssh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder

class MonitorService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Watching agents"
    val notification = build(this, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  companion object {
    private const val CHANNEL_ID = "herdr-monitor"
    private const val NOTIFICATION_ID = 4711
    private const val EXTRA_TEXT = "text"
    private const val AGENTS_URL = "herdrclient://agents"

    fun start(context: Context, text: String) {
      val i = Intent(context, MonitorService::class.java).putExtra(EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, MonitorService::class.java))
    }

    private fun smallIcon(context: Context): Int {
      val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      return if (id != 0) id else android.R.drawable.stat_notify_sync_noanim
    }

    private fun build(context: Context, text: String): Notification {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Agent monitoring", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while the app keeps server connections open in the background"
            setShowBadge(false)
          },
        )
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val pi = launch?.component?.let { component ->
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(AGENTS_URL))
          .setComponent(component)
          .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID)
      else @Suppress("DEPRECATION") Notification.Builder(context)
      return b.setContentTitle("Herdr Client")
        .setContentText(text)
        .setSmallIcon(smallIcon(context))
        .setColor(0xFF4F8CFF.toInt())
        .setOngoing(true)
        .setContentIntent(pi)
        .build()
    }
  }
}
