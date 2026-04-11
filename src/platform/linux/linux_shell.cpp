#include "network_watch/application.hpp"

#include <glib-unix.h>
#include <gtk/gtk.h>
#include <libayatana-appindicator/app-indicator.h>
#include <libnotify/notify.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_linux_metrics_provider();

namespace {

enum class ChartKind {
    Cpu,
    Memory,
    Network,
};

std::string format_bytes(double bytes) {
    static constexpr std::string_view kUnits[] = {"B", "KB", "MB", "GB", "TB"};
    std::size_t unit_index = 0;

    while (bytes >= 1024.0 && unit_index < std::size(kUnits) - 1) {
        bytes /= 1024.0;
        ++unit_index;
    }

    std::ostringstream output;
    output << std::fixed << std::setprecision(unit_index == 0 ? 0 : 1) << bytes << ' ' << kUnits[unit_index];
    return output.str();
}

std::string format_rate(double bytes_per_second) {
    return format_bytes(bytes_per_second) + "/s";
}

std::string format_percent(double value) {
    std::ostringstream output;
    output << std::fixed << std::setprecision(1) << value << '%';
    return output.str();
}

std::string format_timestamp(const TimePoint& timestamp) {
    const auto value = Clock::to_time_t(timestamp);
    std::tm tm_value {};
    localtime_r(&value, &tm_value);

    std::ostringstream output;
    output << std::put_time(&tm_value, "%Y-%m-%d %H:%M:%S");
    return output.str();
}

std::string format_epoch_seconds(std::int64_t epoch_seconds) {
    return format_timestamp(TimePoint(std::chrono::seconds(epoch_seconds)));
}

std::string current_executable_path() {
    std::vector<char> buffer(4096, '\0');
    const auto result = ::readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
    if (result > 0) {
        buffer[static_cast<std::size_t>(result)] = '\0';
        return std::string(buffer.data());
    }
    return (std::filesystem::current_path() / "network_watch").string();
}

std::string alert_metric_label(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
            return "CPU";
        case AlertMetric::MemoryUsage:
            return "Memory";
        case AlertMetric::DownloadRate:
            return "Download";
        case AlertMetric::UploadRate:
            return "Upload";
        case AlertMetric::NetworkDisconnected:
            return "Network";
    }
    return "Unknown";
}

std::string alert_state_label(AlertState state) {
    return state == AlertState::Triggered ? "Triggered" : "Recovered";
}

double threshold_to_display(AlertMetric metric, double raw_threshold) {
    switch (metric) {
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return raw_threshold / (1024.0 * 1024.0);
        default:
            return raw_threshold;
    }
}

double threshold_from_display(AlertMetric metric, double display_threshold) {
    switch (metric) {
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return display_threshold * 1024.0 * 1024.0;
        default:
            return display_threshold;
    }
}

const char* threshold_unit_label(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
        case AlertMetric::MemoryUsage:
            return "%";
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return "MB/s";
        case AlertMetric::NetworkDisconnected:
            return "state";
    }
    return "";
}

double threshold_min(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
        case AlertMetric::MemoryUsage:
            return 0.0;
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return 0.0;
        case AlertMetric::NetworkDisconnected:
            return 0.0;
    }
    return 0.0;
}

double threshold_max(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
        case AlertMetric::MemoryUsage:
            return 100.0;
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return 10240.0;
        case AlertMetric::NetworkDisconnected:
            return 1.0;
    }
    return 100.0;
}

double threshold_step(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
        case AlertMetric::MemoryUsage:
            return 1.0;
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return 0.5;
        case AlertMetric::NetworkDisconnected:
            return 0.1;
    }
    return 1.0;
}

std::uint32_t threshold_digits(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate:
            return 1;
        case AlertMetric::NetworkDisconnected:
            return 2;
        default:
            return 1;
    }
}

bool rules_equal(const std::vector<AlertRule>& left, const std::vector<AlertRule>& right) {
    if (left.size() != right.size()) {
        return false;
    }

    for (std::size_t index = 0; index < left.size(); ++index) {
        const auto& lhs = left[index];
        const auto& rhs = right[index];
        if (lhs.id != rhs.id ||
            lhs.metric != rhs.metric ||
            lhs.threshold != rhs.threshold ||
            lhs.trigger_when_below != rhs.trigger_when_below ||
            lhs.sustain_for != rhs.sustain_for ||
            lhs.cooldown_for != rhs.cooldown_for ||
            lhs.enabled != rhs.enabled ||
            lhs.notification_snooze_until_epoch_seconds != rhs.notification_snooze_until_epoch_seconds) {
            return false;
        }
    }

    return true;
}

bool runtime_settings_changed(const Settings& previous, const Settings& current) {
    return previous.sample_interval != current.sample_interval ||
           !rules_equal(previous.alert_rules, current.alert_rules);
}

bool settings_equal(const Settings& previous, const Settings& current) {
    return previous.sample_interval == current.sample_interval &&
           previous.tray_refresh_interval == current.tray_refresh_interval &&
           previous.notifications_enabled == current.notifications_enabled &&
           previous.notification_snooze_until_epoch_seconds == current.notification_snooze_until_epoch_seconds &&
           previous.quiet_hours_enabled == current.quiet_hours_enabled &&
           previous.quiet_hours_start_minute == current.quiet_hours_start_minute &&
           previous.quiet_hours_end_minute == current.quiet_hours_end_minute &&
           previous.autostart_enabled == current.autostart_enabled &&
           previous.print_tray_updates == current.print_tray_updates &&
           rules_equal(previous.alert_rules, current.alert_rules);
}

std::string format_clock_minute(int minute_of_day) {
    const int normalized = ((minute_of_day % (24 * 60)) + (24 * 60)) % (24 * 60);
    const int hours = normalized / 60;
    const int minutes = normalized % 60;

    std::ostringstream output;
    output << std::setfill('0') << std::setw(2) << hours << ':' << std::setw(2) << minutes;
    return output.str();
}

std::string notification_status_text(const Settings& settings) {
    if (!settings.notifications_enabled) {
        return "Desktop notifications are disabled.";
    }
    if (settings.notification_snooze_until_epoch_seconds.has_value()) {
        const auto now = std::chrono::system_clock::now();
        const auto snooze_until = std::chrono::system_clock::time_point(
            std::chrono::seconds(*settings.notification_snooze_until_epoch_seconds));
        if (now < snooze_until) {
            return "Desktop notifications snoozed until " +
                format_epoch_seconds(*settings.notification_snooze_until_epoch_seconds) + ".";
        }
    }
    if (quiet_hours_active(settings, std::chrono::system_clock::now())) {
        return "Desktop notifications paused by quiet hours (" +
            format_clock_minute(settings.quiet_hours_start_minute) + "-" +
            format_clock_minute(settings.quiet_hours_end_minute) + ").";
    }
    if (settings.quiet_hours_enabled) {
        return "Desktop notifications are active. Quiet hours: " +
            format_clock_minute(settings.quiet_hours_start_minute) + "-" +
            format_clock_minute(settings.quiet_hours_end_minute) + ".";
    }
    return "Desktop notifications are active.";
}

std::string rule_notification_status_text(const AlertRule& rule) {
    if (!rule.notification_snooze_until_epoch_seconds.has_value()) {
        return "Notify";
    }

    const auto now = std::chrono::system_clock::now();
    const auto snooze_until = std::chrono::system_clock::time_point(
        std::chrono::seconds(*rule.notification_snooze_until_epoch_seconds));
    if (now >= snooze_until) {
        return "Resume";
    }
    return "Muted until " + format_epoch_seconds(*rule.notification_snooze_until_epoch_seconds);
}

class LinuxAutostartAdapter final : public IAutostartAdapter {
public:
    LinuxAutostartAdapter() {
        const char* home = std::getenv("HOME");
        if (home != nullptr) {
            file_path_ = std::filesystem::path(home) / ".config/autostart/network-watch.desktop";
        } else {
            file_path_ = "network-watch.desktop";
        }
    }

    bool enable(const std::string& executable_path) override {
        std::filesystem::create_directories(file_path_.parent_path());
        std::ofstream output(file_path_);
        output << "[Desktop Entry]\n";
        output << "Type=Application\n";
        output << "Name=network_watch\n";
        output << "Comment=Cross-platform tray monitor\n";
        output << "Exec=" << executable_path << '\n';
        output << "Terminal=false\n";
        output << "Categories=Utility;System;\n";
        output << "X-GNOME-Autostart-enabled=true\n";
        return static_cast<bool>(output);
    }

    bool disable() override {
        return !std::filesystem::exists(file_path_) || std::filesystem::remove(file_path_);
    }

    bool is_enabled() const override {
        return std::filesystem::exists(file_path_);
    }

private:
    std::filesystem::path file_path_;
};

class LinuxNotificationAdapter final : public INotificationAdapter {
public:
    LinuxNotificationAdapter() {
        initialized_ = notify_init("network_watch");
    }

    ~LinuxNotificationAdapter() override {
        if (initialized_) {
            notify_uninit();
        }
    }

    void notify(const AlertEvent& event) override {
        if (!initialized_) {
            return;
        }

        auto* payload = new Payload {
            event.state == AlertState::Triggered ? "Network Watch Alert" : "Network Watch Recovery",
            event.message,
            event.state == AlertState::Triggered ? "dialog-warning-symbolic" : "emblem-default-symbolic",
        };

        g_idle_add(&LinuxNotificationAdapter::show_notification_on_main, payload);
    }

private:
    struct Payload {
        std::string title;
        std::string body;
        std::string icon_name;
    };

    static gboolean show_notification_on_main(gpointer user_data) {
        std::unique_ptr<Payload> payload(static_cast<Payload*>(user_data));

        NotifyNotification* notification = notify_notification_new(
            payload->title.c_str(),
            payload->body.c_str(),
            payload->icon_name.c_str());
        notify_notification_set_timeout(notification, 5000);
        notify_notification_show(notification, nullptr);
        g_object_unref(notification);

        return G_SOURCE_REMOVE;
    }

    bool initialized_ = false;
};

class LinuxTrayAdapter final : public ITrayAdapter {
public:
    using SettingsListener = std::function<void(const Settings&)>;

    LinuxTrayAdapter(Settings settings, std::filesystem::path config_path, IAutostartAdapter* autostart_adapter)
        : settings_(std::move(settings)),
          config_path_(std::move(config_path)),
          autostart_adapter_(autostart_adapter),
          executable_path_(current_executable_path()) {}

    void initialize() override {
        int argc = 0;
        char** argv = nullptr;
        if (!gtk_init_check(&argc, &argv)) {
            throw std::runtime_error("Failed to initialize GTK. Ensure a desktop session is available.");
        }

        sync_autostart_with_settings();
        create_window();
        create_menu();
        create_indicator();
        sync_settings_widgets_from_model();

        g_unix_signal_add(SIGINT, &LinuxTrayAdapter::on_unix_signal, this);
        g_unix_signal_add(SIGTERM, &LinuxTrayAdapter::on_unix_signal, this);

        initialized_ = true;
    }

    void update(const TraySummary& summary) override {
        {
            std::scoped_lock lock(mutex_);
            summary_ = summary;
        }
        g_idle_add(&LinuxTrayAdapter::sync_summary_on_main, this);
    }

    void show_window(const MetricDelta& latest, const HistorySnapshot& history) override {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
        }
        g_idle_add(&LinuxTrayAdapter::sync_metrics_on_main, this);
    }

    void consume_metric_update(const MetricDelta& latest, const HistorySnapshot& history) {
        bool update_summary_now = false;
        TraySummary summary;

        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;

            if (!last_summary_update_.has_value() ||
                (latest.timestamp - *last_summary_update_) >= settings_.tray_refresh_interval) {
                summary_ = build_tray_summary(latest);
                last_summary_update_ = latest.timestamp;
                summary = summary_;
                update_summary_now = true;
            }
        }

        g_idle_add(&LinuxTrayAdapter::sync_metrics_on_main, this);
        if (update_summary_now) {
            g_idle_add(&LinuxTrayAdapter::sync_summary_on_main, this);
        }
    }

    void shutdown() override {
        if (!initialized_) {
            return;
        }

        if (window_ != nullptr) {
            gtk_widget_destroy(window_);
            window_ = nullptr;
        }
        if (indicator_ != nullptr) {
            g_object_unref(indicator_);
            indicator_ = nullptr;
        }

        initialized_ = false;
    }

    int run_loop() {
        gtk_main();
        return 0;
    }

    void request_quit() {
        g_idle_add(&LinuxTrayAdapter::quit_on_main, this);
    }

    void append_alert(const AlertEvent& event) {
        {
            std::scoped_lock lock(mutex_);

            std::ostringstream line;
            line << "[" << format_timestamp(event.timestamp) << "] "
                 << alert_state_label(event.state) << " "
                 << alert_metric_label(event.metric) << ": "
                 << event.message;
            alert_lines_.push_front(line.str());

            constexpr std::size_t kMaxAlerts = 100;
            while (alert_lines_.size() > kMaxAlerts) {
                alert_lines_.pop_back();
            }
        }

        g_idle_add(&LinuxTrayAdapter::sync_alerts_on_main, this);
    }

    bool notifications_enabled() const {
        return notifications_allowed(settings_snapshot());
    }

    bool notifications_enabled_for_rule(const std::string& rule_id) const {
        return alert_rule_notifications_allowed(settings_snapshot(), rule_id);
    }

    void set_settings_listener(SettingsListener listener) {
        std::scoped_lock lock(mutex_);
        settings_listener_ = std::move(listener);
    }

private:
    struct RuleEditorWidgets {
        std::string rule_id;
        AlertMetric metric = AlertMetric::CpuUsage;
        GtkWidget* enabled = nullptr;
        GtkWidget* threshold = nullptr;
        GtkWidget* sustain = nullptr;
        GtkWidget* cooldown = nullptr;
        GtkWidget* direction = nullptr;
        GtkWidget* reset_button = nullptr;
        GtkWidget* notify_button = nullptr;
    };

    Settings settings_snapshot() const {
        std::scoped_lock lock(mutex_);
        return settings_;
    }

    void persist_settings() {
        save_settings(config_path_, settings_snapshot());
    }

    void set_status_message(const std::string& message) {
        if (settings_status_label_ != nullptr) {
            gtk_label_set_text(GTK_LABEL(settings_status_label_), message.c_str());
        }
    }

    bool settings_form_is_dirty() const {
        if (sample_interval_spin_ == nullptr) {
            return false;
        }
        return !settings_equal(settings_snapshot(), collect_settings_from_widgets());
    }

    void update_settings_dirty_state() {
        if (apply_settings_button_ != nullptr) {
            gtk_widget_set_sensitive(apply_settings_button_, settings_form_is_dirty());
        }
        if (settings_dirty_label_ != nullptr) {
            gtk_label_set_text(
                GTK_LABEL(settings_dirty_label_),
                settings_form_is_dirty() ? "Unsaved changes in settings form." : "All settings changes are saved.");
        }
    }

    void sync_notification_controls() {
        const auto settings = settings_snapshot();
        const auto status = notification_status_text(settings);

        if (notification_status_item_ != nullptr) {
            gtk_menu_item_set_label(GTK_MENU_ITEM(notification_status_item_), status.c_str());
        }
        if (notification_runtime_label_ != nullptr) {
            gtk_label_set_text(GTK_LABEL(notification_runtime_label_), status.c_str());
        }

        const bool can_resume = settings.notifications_enabled || settings.notification_snooze_until_epoch_seconds.has_value();
        if (resume_notifications_item_ != nullptr) {
            gtk_widget_set_sensitive(resume_notifications_item_, can_resume);
        }
        if (snooze_30m_item_ != nullptr) {
            gtk_widget_set_sensitive(snooze_30m_item_, settings.notifications_enabled);
        }
        if (snooze_2h_item_ != nullptr) {
            gtk_widget_set_sensitive(snooze_2h_item_, settings.notifications_enabled);
        }
    }

    void populate_rule_form(const RuleEditorWidgets& editor, const AlertRule& rule) {
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(editor.enabled), rule.enabled);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(editor.threshold), threshold_to_display(rule.metric, rule.threshold));
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(editor.sustain), static_cast<double>(rule.sustain_for.count()));
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(editor.cooldown), static_cast<double>(rule.cooldown_for.count()));
        if (editor.notify_button != nullptr) {
            gtk_button_set_label(GTK_BUTTON(editor.notify_button), rule_notification_status_text(rule).c_str());
        }
    }

    void sync_autostart_with_settings() {
        if (autostart_adapter_ == nullptr) {
            return;
        }

        const bool should_enable = settings_.autostart_enabled;
        const bool currently_enabled = autostart_adapter_->is_enabled();
        if (should_enable == currently_enabled) {
            return;
        }

        const bool success = should_enable
            ? autostart_adapter_->enable(executable_path_)
            : autostart_adapter_->disable();
        if (!success) {
            settings_.autostart_enabled = currently_enabled;
        }
    }

    void create_indicator() {
        indicator_ = app_indicator_new(
            "network_watch",
            "network-transmit-receive-symbolic",
            APP_INDICATOR_CATEGORY_SYSTEM_SERVICES);
        app_indicator_set_status(indicator_, APP_INDICATOR_STATUS_ACTIVE);
        app_indicator_set_menu(indicator_, GTK_MENU(menu_));
        app_indicator_set_title(indicator_, "Network Watch");
        app_indicator_set_label(indicator_, "Starting...", "");
    }

    void create_menu() {
        menu_ = gtk_menu_new();

        GtkWidget* title_item = gtk_menu_item_new_with_label("Network Watch");
        gtk_widget_set_sensitive(title_item, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), title_item);

        GtkWidget* separator_top = gtk_separator_menu_item_new();
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), separator_top);

        summary_menu_item_ = gtk_menu_item_new_with_label("Down -- | Up --");
        gtk_widget_set_sensitive(summary_menu_item_, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), summary_menu_item_);

        cpu_menu_item_ = gtk_menu_item_new_with_label("CPU -- | Memory --");
        gtk_widget_set_sensitive(cpu_menu_item_, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), cpu_menu_item_);

        network_menu_item_ = gtk_menu_item_new_with_label("Network --");
        gtk_widget_set_sensitive(network_menu_item_, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), network_menu_item_);

        GtkWidget* separator_mid = gtk_separator_menu_item_new();
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), separator_mid);

        notification_status_item_ = gtk_menu_item_new_with_label("Desktop notifications are active.");
        gtk_widget_set_sensitive(notification_status_item_, FALSE);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), notification_status_item_);

        open_item_ = gtk_menu_item_new_with_label("Open Monitor");
        g_signal_connect(open_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_open_monitor), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), open_item_);

        settings_item_ = gtk_menu_item_new_with_label("Open Settings");
        g_signal_connect(settings_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_open_settings), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), settings_item_);

        notifications_item_ = gtk_check_menu_item_new_with_label("Enable Notifications");
        g_signal_connect(notifications_item_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_toggle_notifications), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), notifications_item_);

        snooze_30m_item_ = gtk_menu_item_new_with_label("Mute Notifications for 30m");
        g_signal_connect(snooze_30m_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_snooze_30m), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), snooze_30m_item_);

        snooze_2h_item_ = gtk_menu_item_new_with_label("Mute Notifications for 2h");
        g_signal_connect(snooze_2h_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_snooze_2h), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), snooze_2h_item_);

        resume_notifications_item_ = gtk_menu_item_new_with_label("Resume Notifications");
        g_signal_connect(resume_notifications_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_resume_notifications), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), resume_notifications_item_);

        autostart_item_ = gtk_check_menu_item_new_with_label("Launch at Login");
        g_signal_connect(autostart_item_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_toggle_autostart), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), autostart_item_);

        GtkWidget* separator_bottom = gtk_separator_menu_item_new();
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), separator_bottom);

        quit_item_ = gtk_menu_item_new_with_label("Quit");
        g_signal_connect(quit_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_quit), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), quit_item_);

        gtk_widget_show_all(menu_);
    }

    GtkWidget* create_metric_card(const char* title, GtkWidget** value_label) {
        GtkWidget* frame = gtk_frame_new(title);
        GtkWidget* box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
        gtk_container_set_border_width(GTK_CONTAINER(box), 10);

        *value_label = gtk_label_new("--");
        gtk_widget_set_halign(*value_label, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(box), *value_label, FALSE, FALSE, 0);

        gtk_container_add(GTK_CONTAINER(frame), box);
        return frame;
    }

    void create_window() {
        window_ = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        gtk_window_set_title(GTK_WINDOW(window_), "Network Watch");
        gtk_window_set_default_size(GTK_WINDOW(window_), 980, 720);
        g_signal_connect(window_, "delete-event", G_CALLBACK(&LinuxTrayAdapter::on_delete_event), this);

        GtkWidget* outer_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
        gtk_container_set_border_width(GTK_CONTAINER(outer_box), 16);
        gtk_container_add(GTK_CONTAINER(window_), outer_box);

        summary_label_ = gtk_label_new("Waiting for first metrics sample...");
        gtk_widget_set_halign(summary_label_, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(outer_box), summary_label_, FALSE, FALSE, 0);

        updated_at_label_ = gtk_label_new("Last updated: --");
        gtk_widget_set_halign(updated_at_label_, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(outer_box), updated_at_label_, FALSE, FALSE, 0);

        GtkWidget* metrics_grid = gtk_grid_new();
        gtk_grid_set_row_spacing(GTK_GRID(metrics_grid), 10);
        gtk_grid_set_column_spacing(GTK_GRID(metrics_grid), 10);
        gtk_box_pack_start(GTK_BOX(outer_box), metrics_grid, FALSE, FALSE, 0);

        GtkWidget* cpu_frame = create_metric_card("CPU Usage", &cpu_value_label_);
        GtkWidget* memory_frame = create_metric_card("Memory Usage", &memory_value_label_);
        GtkWidget* download_frame = create_metric_card("Download", &download_value_label_);
        GtkWidget* upload_frame = create_metric_card("Upload", &upload_value_label_);
        GtkWidget* network_frame = create_metric_card("Network", &network_value_label_);

        gtk_grid_attach(GTK_GRID(metrics_grid), cpu_frame, 0, 0, 1, 1);
        gtk_grid_attach(GTK_GRID(metrics_grid), memory_frame, 1, 0, 1, 1);
        gtk_grid_attach(GTK_GRID(metrics_grid), download_frame, 2, 0, 1, 1);
        gtk_grid_attach(GTK_GRID(metrics_grid), upload_frame, 0, 1, 1, 1);
        gtk_grid_attach(GTK_GRID(metrics_grid), network_frame, 1, 1, 2, 1);

        notebook_ = gtk_notebook_new();
        gtk_widget_set_vexpand(notebook_, TRUE);
        gtk_box_pack_start(GTK_BOX(outer_box), notebook_, TRUE, TRUE, 0);

        GtkWidget* trends_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
        cpu_chart_ = gtk_drawing_area_new();
        memory_chart_ = gtk_drawing_area_new();
        network_chart_ = gtk_drawing_area_new();

        create_chart_area(cpu_chart_, "CPU Trend", ChartKind::Cpu, trends_box);
        create_chart_area(memory_chart_, "Memory Trend", ChartKind::Memory, trends_box);
        create_chart_area(network_chart_, "Network Throughput", ChartKind::Network, trends_box);
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook_), trends_box, gtk_label_new("Trends"));

        GtkWidget* interfaces_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
        interface_store_ = gtk_list_store_new(5, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING, G_TYPE_STRING);
        GtkWidget* interface_tree = gtk_tree_view_new_with_model(GTK_TREE_MODEL(interface_store_));
        append_text_column(interface_tree, "Interface", 0);
        append_text_column(interface_tree, "Status", 1);
        append_text_column(interface_tree, "Address", 2);
        append_text_column(interface_tree, "Download", 3);
        append_text_column(interface_tree, "Upload", 4);

        GtkWidget* interface_scroll = gtk_scrolled_window_new(nullptr, nullptr);
        gtk_widget_set_vexpand(interface_scroll, TRUE);
        gtk_container_add(GTK_CONTAINER(interface_scroll), interface_tree);
        gtk_box_pack_start(GTK_BOX(interfaces_box), interface_scroll, TRUE, TRUE, 0);
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook_), interfaces_box, gtk_label_new("Interfaces"));

        GtkWidget* alerts_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
        GtkWidget* alerts_action_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_box_pack_start(GTK_BOX(alerts_box), alerts_action_box, FALSE, FALSE, 0);

        clear_alerts_button_ = gtk_button_new_with_label("Clear Alert History");
        g_signal_connect(clear_alerts_button_, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_clear_alerts), this);
        gtk_box_pack_start(GTK_BOX(alerts_action_box), clear_alerts_button_, FALSE, FALSE, 0);

        alerts_hint_label_ = gtk_label_new("Recent alert and recovery events are shown here.");
        gtk_widget_set_halign(alerts_hint_label_, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(alerts_action_box), alerts_hint_label_, FALSE, FALSE, 0);

        GtkWidget* alert_text = gtk_text_view_new();
        gtk_text_view_set_editable(GTK_TEXT_VIEW(alert_text), FALSE);
        gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(alert_text), FALSE);
        alerts_buffer_ = gtk_text_view_get_buffer(GTK_TEXT_VIEW(alert_text));

        GtkWidget* alert_scroll = gtk_scrolled_window_new(nullptr, nullptr);
        gtk_widget_set_vexpand(alert_scroll, TRUE);
        gtk_container_add(GTK_CONTAINER(alert_scroll), alert_text);
        gtk_box_pack_start(GTK_BOX(alerts_box), alert_scroll, TRUE, TRUE, 0);
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook_), alerts_box, gtk_label_new("Alerts"));

        create_settings_page();

        GtkWidget* footer_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_box_pack_end(GTK_BOX(outer_box), footer_box, FALSE, FALSE, 0);

        GtkWidget* hide_button = gtk_button_new_with_label("Hide");
        g_signal_connect_swapped(hide_button, "clicked", G_CALLBACK(gtk_widget_hide), window_);
        gtk_box_pack_end(GTK_BOX(footer_box), hide_button, FALSE, FALSE, 0);

        GtkWidget* quit_button = gtk_button_new_with_label("Quit");
        g_signal_connect(quit_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_quit), this);
        gtk_box_pack_end(GTK_BOX(footer_box), quit_button, FALSE, FALSE, 0);
    }

    void create_settings_page() {
        GtkWidget* settings_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 12);
        gtk_container_set_border_width(GTK_CONTAINER(settings_box), 8);

        GtkWidget* general_frame = gtk_frame_new("General");
        GtkWidget* general_grid = gtk_grid_new();
        gtk_grid_set_row_spacing(GTK_GRID(general_grid), 8);
        gtk_grid_set_column_spacing(GTK_GRID(general_grid), 12);
        gtk_container_set_border_width(GTK_CONTAINER(general_grid), 10);
        gtk_container_add(GTK_CONTAINER(general_frame), general_grid);

        GtkWidget* sample_label = gtk_label_new("Sampling interval (ms)");
        gtk_widget_set_halign(sample_label, GTK_ALIGN_START);
        gtk_grid_attach(GTK_GRID(general_grid), sample_label, 0, 0, 1, 1);
        sample_interval_spin_ = gtk_spin_button_new_with_range(250.0, 10000.0, 250.0);
        gtk_grid_attach(GTK_GRID(general_grid), sample_interval_spin_, 1, 0, 1, 1);

        GtkWidget* tray_label = gtk_label_new("Tray refresh interval (ms)");
        gtk_widget_set_halign(tray_label, GTK_ALIGN_START);
        gtk_grid_attach(GTK_GRID(general_grid), tray_label, 0, 1, 1, 1);
        tray_refresh_spin_ = gtk_spin_button_new_with_range(250.0, 10000.0, 250.0);
        gtk_grid_attach(GTK_GRID(general_grid), tray_refresh_spin_, 1, 1, 1, 1);

        settings_notifications_check_ = gtk_check_button_new_with_label("Enable notifications");
        gtk_grid_attach(GTK_GRID(general_grid), settings_notifications_check_, 0, 2, 2, 1);

        settings_autostart_check_ = gtk_check_button_new_with_label("Launch at login");
        gtk_grid_attach(GTK_GRID(general_grid), settings_autostart_check_, 0, 3, 2, 1);

        quiet_hours_check_ = gtk_check_button_new_with_label("Enable quiet hours");
        gtk_grid_attach(GTK_GRID(general_grid), quiet_hours_check_, 0, 4, 2, 1);

        GtkWidget* quiet_start_label = gtk_label_new("Quiet hours start");
        gtk_widget_set_halign(quiet_start_label, GTK_ALIGN_START);
        gtk_grid_attach(GTK_GRID(general_grid), quiet_start_label, 0, 5, 1, 1);

        GtkWidget* quiet_start_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
        quiet_hours_start_hour_spin_ = gtk_spin_button_new_with_range(0.0, 23.0, 1.0);
        quiet_hours_start_minute_spin_ = gtk_spin_button_new_with_range(0.0, 59.0, 1.0);
        gtk_box_pack_start(GTK_BOX(quiet_start_box), quiet_hours_start_hour_spin_, FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(quiet_start_box), gtk_label_new(":"), FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(quiet_start_box), quiet_hours_start_minute_spin_, FALSE, FALSE, 0);
        gtk_grid_attach(GTK_GRID(general_grid), quiet_start_box, 1, 5, 1, 1);

        GtkWidget* quiet_end_label = gtk_label_new("Quiet hours end");
        gtk_widget_set_halign(quiet_end_label, GTK_ALIGN_START);
        gtk_grid_attach(GTK_GRID(general_grid), quiet_end_label, 0, 6, 1, 1);

        GtkWidget* quiet_end_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
        quiet_hours_end_hour_spin_ = gtk_spin_button_new_with_range(0.0, 23.0, 1.0);
        quiet_hours_end_minute_spin_ = gtk_spin_button_new_with_range(0.0, 59.0, 1.0);
        gtk_box_pack_start(GTK_BOX(quiet_end_box), quiet_hours_end_hour_spin_, FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(quiet_end_box), gtk_label_new(":"), FALSE, FALSE, 0);
        gtk_box_pack_start(GTK_BOX(quiet_end_box), quiet_hours_end_minute_spin_, FALSE, FALSE, 0);
        gtk_grid_attach(GTK_GRID(general_grid), quiet_end_box, 1, 6, 1, 1);

        notification_runtime_label_ = gtk_label_new("Desktop notifications are active.");
        gtk_widget_set_halign(notification_runtime_label_, GTK_ALIGN_START);
        gtk_grid_attach(GTK_GRID(general_grid), notification_runtime_label_, 0, 7, 2, 1);

        gtk_box_pack_start(GTK_BOX(settings_box), general_frame, FALSE, FALSE, 0);

        GtkWidget* rules_frame = gtk_frame_new("Alert Rules");
        GtkWidget* rules_scroll = gtk_scrolled_window_new(nullptr, nullptr);
        gtk_widget_set_vexpand(rules_scroll, TRUE);
        gtk_container_add(GTK_CONTAINER(rules_frame), rules_scroll);

        GtkWidget* rules_grid = gtk_grid_new();
        gtk_grid_set_row_spacing(GTK_GRID(rules_grid), 8);
        gtk_grid_set_column_spacing(GTK_GRID(rules_grid), 10);
        gtk_container_set_border_width(GTK_CONTAINER(rules_grid), 10);
        gtk_container_add(GTK_CONTAINER(rules_scroll), rules_grid);

        const char* headers[] = {"Rule", "Enabled", "When", "Threshold", "Sustain(s)", "Cooldown(s)", "Notify", "Reset"};
        for (int column = 0; column < 8; ++column) {
            GtkWidget* label = gtk_label_new(headers[column]);
            gtk_widget_set_halign(label, GTK_ALIGN_START);
            gtk_grid_attach(GTK_GRID(rules_grid), label, column, 0, 1, 1);
        }

        const auto settings = settings_snapshot();
        for (std::size_t index = 0; index < settings.alert_rules.size(); ++index) {
            const auto& rule = settings.alert_rules[index];
            const int row = static_cast<int>(index) + 1;

            RuleEditorWidgets widgets;
            widgets.rule_id = rule.id;
            widgets.metric = rule.metric;

            GtkWidget* name = gtk_label_new(rule.id.c_str());
            gtk_widget_set_halign(name, GTK_ALIGN_START);
            gtk_grid_attach(GTK_GRID(rules_grid), name, 0, row, 1, 1);

            widgets.enabled = gtk_check_button_new();
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.enabled, 1, row, 1, 1);

            widgets.direction = gtk_label_new(rule.trigger_when_below ? "<" : ">");
            gtk_widget_set_halign(widgets.direction, GTK_ALIGN_CENTER);
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.direction, 2, row, 1, 1);

            GtkWidget* threshold_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
            widgets.threshold = gtk_spin_button_new_with_range(
                threshold_min(rule.metric),
                threshold_max(rule.metric),
                threshold_step(rule.metric));
            gtk_spin_button_set_digits(GTK_SPIN_BUTTON(widgets.threshold), threshold_digits(rule.metric));
            gtk_box_pack_start(GTK_BOX(threshold_box), widgets.threshold, FALSE, FALSE, 0);
            GtkWidget* unit = gtk_label_new(threshold_unit_label(rule.metric));
            gtk_box_pack_start(GTK_BOX(threshold_box), unit, FALSE, FALSE, 0);
            gtk_grid_attach(GTK_GRID(rules_grid), threshold_box, 3, row, 1, 1);

            widgets.sustain = gtk_spin_button_new_with_range(1.0, 3600.0, 1.0);
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.sustain, 4, row, 1, 1);

            widgets.cooldown = gtk_spin_button_new_with_range(1.0, 7200.0, 1.0);
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.cooldown, 5, row, 1, 1);

            widgets.notify_button = gtk_button_new_with_label(rule_notification_status_text(rule).c_str());
            g_object_set_data(G_OBJECT(widgets.notify_button), "rule-index", GINT_TO_POINTER(static_cast<int>(index)));
            g_signal_connect(widgets.notify_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_toggle_rule_notification_snooze), this);
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.notify_button, 6, row, 1, 1);

            widgets.reset_button = gtk_button_new_with_label("Reset");
            g_object_set_data(G_OBJECT(widgets.reset_button), "rule-index", GINT_TO_POINTER(static_cast<int>(index)));
            g_signal_connect(widgets.reset_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_reset_rule), this);
            gtk_grid_attach(GTK_GRID(rules_grid), widgets.reset_button, 7, row, 1, 1);

            if (rule.metric == AlertMetric::NetworkDisconnected) {
                gtk_widget_set_tooltip_text(widgets.threshold, "Network disconnection uses a fixed connectivity threshold.");
            }

            g_signal_connect(widgets.enabled, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
            g_signal_connect(widgets.threshold, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
            g_signal_connect(widgets.sustain, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
            g_signal_connect(widgets.cooldown, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);

            rule_editors_.push_back(widgets);
        }

        g_signal_connect(sample_interval_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(tray_refresh_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(settings_notifications_check_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(settings_autostart_check_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(quiet_hours_check_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(quiet_hours_start_hour_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(quiet_hours_start_minute_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(quiet_hours_end_hour_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);
        g_signal_connect(quiet_hours_end_minute_spin_, "value-changed", G_CALLBACK(&LinuxTrayAdapter::on_settings_widget_changed), this);

        gtk_box_pack_start(GTK_BOX(settings_box), rules_frame, TRUE, TRUE, 0);

        GtkWidget* action_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_box_pack_start(GTK_BOX(settings_box), action_box, FALSE, FALSE, 0);

        GtkWidget* apply_button = gtk_button_new_with_label("Apply");
        g_signal_connect(apply_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_apply_settings), this);
        apply_settings_button_ = apply_button;
        gtk_box_pack_start(GTK_BOX(action_box), apply_button, FALSE, FALSE, 0);

        GtkWidget* reload_button = gtk_button_new_with_label("Reload Saved");
        g_signal_connect(reload_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_reload_saved), this);
        gtk_box_pack_start(GTK_BOX(action_box), reload_button, FALSE, FALSE, 0);

        GtkWidget* defaults_button = gtk_button_new_with_label("Load Defaults");
        g_signal_connect(defaults_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_load_defaults), this);
        gtk_box_pack_start(GTK_BOX(action_box), defaults_button, FALSE, FALSE, 0);

        settings_status_label_ = gtk_label_new("Settings are loaded from the current configuration.");
        gtk_widget_set_halign(settings_status_label_, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(settings_box), settings_status_label_, FALSE, FALSE, 0);

        settings_dirty_label_ = gtk_label_new("All settings changes are saved.");
        gtk_widget_set_halign(settings_dirty_label_, GTK_ALIGN_START);
        gtk_box_pack_start(GTK_BOX(settings_box), settings_dirty_label_, FALSE, FALSE, 0);

        settings_page_index_ = gtk_notebook_append_page(GTK_NOTEBOOK(notebook_), settings_box, gtk_label_new("Settings"));
    }

    void create_chart_area(GtkWidget* area, const char* title, ChartKind kind, GtkWidget* parent_box) {
        gtk_widget_set_size_request(area, -1, 130);
        g_object_set_data(G_OBJECT(area), "chart-kind", GINT_TO_POINTER(static_cast<int>(kind)));
        g_signal_connect(area, "draw", G_CALLBACK(&LinuxTrayAdapter::on_draw_chart), this);

        GtkWidget* frame = gtk_frame_new(title);
        gtk_container_add(GTK_CONTAINER(frame), area);
        gtk_box_pack_start(GTK_BOX(parent_box), frame, TRUE, TRUE, 0);
    }

    void append_text_column(GtkWidget* tree, const char* title, int column_index) {
        GtkCellRenderer* renderer = gtk_cell_renderer_text_new();
        GtkTreeViewColumn* column =
            gtk_tree_view_column_new_with_attributes(title, renderer, "text", column_index, nullptr);
        gtk_tree_view_append_column(GTK_TREE_VIEW(tree), column);
    }

    void present_window(int page_index = 0) {
        if (notebook_ != nullptr) {
            gtk_notebook_set_current_page(GTK_NOTEBOOK(notebook_), page_index);
        }
        gtk_widget_show_all(window_);
        gtk_window_present(GTK_WINDOW(window_));
    }

    void populate_settings_form(const Settings& settings) {
        suppress_signal_updates_ = true;
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(sample_interval_spin_), static_cast<double>(settings.sample_interval.count()));
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(tray_refresh_spin_), static_cast<double>(settings.tray_refresh_interval.count()));
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(settings_notifications_check_), settings.notifications_enabled);
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(settings_autostart_check_), settings.autostart_enabled);
        gtk_toggle_button_set_active(GTK_TOGGLE_BUTTON(quiet_hours_check_), settings.quiet_hours_enabled);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(quiet_hours_start_hour_spin_), settings.quiet_hours_start_minute / 60);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(quiet_hours_start_minute_spin_), settings.quiet_hours_start_minute % 60);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(quiet_hours_end_hour_spin_), settings.quiet_hours_end_minute / 60);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(quiet_hours_end_minute_spin_), settings.quiet_hours_end_minute % 60);

        for (std::size_t index = 0; index < settings.alert_rules.size() && index < rule_editors_.size(); ++index) {
            const auto& rule = settings.alert_rules[index];
            const auto& editor = rule_editors_[index];
            populate_rule_form(editor, rule);
        }
        suppress_signal_updates_ = false;
        update_settings_dirty_state();
    }

    void sync_settings_widgets_from_model() {
        const auto settings = settings_snapshot();
        populate_settings_form(settings);
        suppress_signal_updates_ = true;
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(notifications_item_), settings.notifications_enabled);
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(autostart_item_), settings.autostart_enabled);
        suppress_signal_updates_ = false;
        sync_notification_controls();
        update_settings_dirty_state();
    }

    Settings collect_settings_from_widgets() const {
        auto settings = settings_snapshot();

        settings.sample_interval = std::chrono::milliseconds(
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(sample_interval_spin_)));
        settings.tray_refresh_interval = std::chrono::milliseconds(
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(tray_refresh_spin_)));
        settings.notifications_enabled = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(settings_notifications_check_));
        settings.autostart_enabled = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(settings_autostart_check_));
        settings.quiet_hours_enabled = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(quiet_hours_check_));
        settings.quiet_hours_start_minute =
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(quiet_hours_start_hour_spin_)) * 60 +
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(quiet_hours_start_minute_spin_));
        settings.quiet_hours_end_minute =
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(quiet_hours_end_hour_spin_)) * 60 +
            gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(quiet_hours_end_minute_spin_));
        if (!settings.notifications_enabled) {
            settings.notification_snooze_until_epoch_seconds.reset();
        }

        for (std::size_t index = 0; index < settings.alert_rules.size() && index < rule_editors_.size(); ++index) {
            auto& rule = settings.alert_rules[index];
            const auto& editor = rule_editors_[index];
            rule.enabled = gtk_toggle_button_get_active(GTK_TOGGLE_BUTTON(editor.enabled));
            if (rule.metric != AlertMetric::NetworkDisconnected) {
                rule.threshold = threshold_from_display(
                    rule.metric,
                    gtk_spin_button_get_value(GTK_SPIN_BUTTON(editor.threshold)));
            }
            rule.sustain_for = std::chrono::seconds(
                gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(editor.sustain)));
            rule.cooldown_for = std::chrono::seconds(
                gtk_spin_button_get_value_as_int(GTK_SPIN_BUTTON(editor.cooldown)));
        }

        return settings;
    }

    void apply_settings(Settings new_settings, bool notify_runtime, const std::string& status_message) {
        const auto previous = settings_snapshot();

        if (autostart_adapter_ != nullptr && previous.autostart_enabled != new_settings.autostart_enabled) {
            const bool success = new_settings.autostart_enabled
                ? autostart_adapter_->enable(executable_path_)
                : autostart_adapter_->disable();
            if (!success) {
                sync_settings_widgets_from_model();
                set_status_message("Failed to update launch-at-login entry.");
                return;
            }
        }

        {
            std::scoped_lock lock(mutex_);
            settings_ = new_settings;
        }

        persist_settings();
        sync_settings_widgets_from_model();
        set_status_message(status_message);
        update_settings_dirty_state();

        if (notify_runtime && runtime_settings_changed(previous, new_settings)) {
            SettingsListener listener;
            {
                std::scoped_lock lock(mutex_);
                listener = settings_listener_;
            }
            if (listener) {
                listener(new_settings);
            }
        }
    }

    void apply_summary() {
        TraySummary summary;
        {
            std::scoped_lock lock(mutex_);
            summary = summary_;
        }

        const char* icon = summary.warning ? "dialog-warning-symbolic" : "network-transmit-receive-symbolic";
        app_indicator_set_icon_full(indicator_, icon, "network_watch");
        app_indicator_set_label(indicator_, summary.title.c_str(), "");
        app_indicator_set_title(indicator_, summary.tooltip.c_str());

        if (summary_label_ != nullptr) {
            gtk_label_set_text(GTK_LABEL(summary_label_), summary.tooltip.c_str());
        }
        if (summary_menu_item_ != nullptr) {
            gtk_menu_item_set_label(GTK_MENU_ITEM(summary_menu_item_), summary.title.c_str());
        }
    }

    void apply_metrics() {
        std::optional<MetricDelta> latest;
        HistorySnapshot history;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
            history = history_;
        }

        if (!latest.has_value()) {
            return;
        }

        gtk_label_set_text(GTK_LABEL(cpu_value_label_), format_percent(latest->cpu_usage_percent).c_str());

        const std::string memory_text =
            format_percent(latest->memory_usage_percent) + " (" +
            format_bytes(static_cast<double>(latest->memory_used_bytes)) + " / " +
            format_bytes(static_cast<double>(latest->memory_total_bytes)) + ")";
        gtk_label_set_text(GTK_LABEL(memory_value_label_), memory_text.c_str());

        gtk_label_set_text(GTK_LABEL(download_value_label_), format_rate(latest->download_bytes_per_second).c_str());
        gtk_label_set_text(GTK_LABEL(upload_value_label_), format_rate(latest->upload_bytes_per_second).c_str());
        gtk_label_set_text(GTK_LABEL(network_value_label_), latest->network_connected ? "Connected" : "Offline");

        const auto updated_text = "Last updated: " + format_timestamp(latest->timestamp);
        gtk_label_set_text(GTK_LABEL(updated_at_label_), updated_text.c_str());

        if (cpu_menu_item_ != nullptr) {
            const auto cpu_line =
                "CPU " + format_percent(latest->cpu_usage_percent) +
                " | Memory " + format_percent(latest->memory_usage_percent);
            gtk_menu_item_set_label(GTK_MENU_ITEM(cpu_menu_item_), cpu_line.c_str());
        }
        if (network_menu_item_ != nullptr) {
            const auto network_line =
                std::string(latest->network_connected ? "Network online | " : "Network offline | ") +
                "Down " + format_rate(latest->download_bytes_per_second) +
                " | Up " + format_rate(latest->upload_bytes_per_second);
            gtk_menu_item_set_label(GTK_MENU_ITEM(network_menu_item_), network_line.c_str());
        }

        gtk_list_store_clear(interface_store_);
        for (const auto& item : latest->interfaces) {
            GtkTreeIter iter;
            gtk_list_store_append(interface_store_, &iter);
            gtk_list_store_set(
                interface_store_,
                &iter,
                0,
                item.name.c_str(),
                1,
                item.is_up ? "Up" : "Down",
                2,
                item.address.c_str(),
                3,
                format_rate(item.rx_bytes_per_second).c_str(),
                4,
                format_rate(item.tx_bytes_per_second).c_str(),
                -1);
        }

        gtk_widget_queue_draw(cpu_chart_);
        gtk_widget_queue_draw(memory_chart_);
        gtk_widget_queue_draw(network_chart_);
    }

    void apply_alerts() {
        std::deque<std::string> lines;
        {
            std::scoped_lock lock(mutex_);
            lines = alert_lines_;
        }

        if (clear_alerts_button_ != nullptr) {
            gtk_widget_set_sensitive(clear_alerts_button_, !lines.empty());
        }

        std::ostringstream output;
        if (lines.empty()) {
            output << "No alerts yet.";
        } else {
            for (const auto& line : lines) {
                output << line << '\n';
            }
        }
        gtk_text_buffer_set_text(alerts_buffer_, output.str().c_str(), -1);
        if (alerts_hint_label_ != nullptr) {
            const auto hint = lines.empty()
                ? std::string("Recent alert and recovery events will appear here.")
                : std::to_string(lines.size()) + " recent alert events in memory.";
            gtk_label_set_text(GTK_LABEL(alerts_hint_label_), hint.c_str());
        }
    }

    void draw_chart(GtkWidget* widget, cairo_t* cr) {
        const int width = gtk_widget_get_allocated_width(widget);
        const int height = gtk_widget_get_allocated_height(widget);
        const auto kind = static_cast<ChartKind>(GPOINTER_TO_INT(g_object_get_data(G_OBJECT(widget), "chart-kind")));

        cairo_set_source_rgb(cr, 0.08, 0.10, 0.13);
        cairo_paint(cr);

        cairo_set_source_rgb(cr, 0.18, 0.20, 0.24);
        for (int i = 1; i < 4; ++i) {
            const double y = static_cast<double>(height) * i / 4.0;
            cairo_move_to(cr, 0.0, y);
            cairo_line_to(cr, static_cast<double>(width), y);
        }
        cairo_stroke(cr);

        HistorySnapshot history;
        {
            std::scoped_lock lock(mutex_);
            history = history_;
        }

        const auto& samples = history.last_five_minutes;
        if (samples.empty()) {
            cairo_set_source_rgb(cr, 0.85, 0.85, 0.85);
            cairo_move_to(cr, 16.0, height / 2.0);
            cairo_show_text(cr, "Waiting for enough samples...");
            return;
        }

        auto draw_line = [&](const std::vector<double>& values, double max_value, double red, double green, double blue) {
            if (values.empty() || max_value <= 0.0) {
                return;
            }

            cairo_set_source_rgb(cr, red, green, blue);
            cairo_set_line_width(cr, 2.0);

            for (std::size_t index = 0; index < values.size(); ++index) {
                const double x = values.size() == 1
                    ? width / 2.0
                    : (static_cast<double>(index) / (values.size() - 1)) * (width - 16.0) + 8.0;
                const double normalized = std::clamp(values[index] / max_value, 0.0, 1.0);
                const double y = (height - 14.0) - normalized * (height - 28.0);

                if (index == 0) {
                    cairo_move_to(cr, x, y);
                } else {
                    cairo_line_to(cr, x, y);
                }
            }
            cairo_stroke(cr);
        };

        if (kind == ChartKind::Cpu || kind == ChartKind::Memory) {
            std::vector<double> values;
            values.reserve(samples.size());
            for (const auto& sample : samples) {
                values.push_back(kind == ChartKind::Cpu ? sample.cpu_usage_percent : sample.memory_usage_percent);
            }
            draw_line(values, 100.0, kind == ChartKind::Cpu ? 0.23 : 0.15, 0.72, kind == ChartKind::Cpu ? 0.98 : 0.48);
            return;
        }

        std::vector<double> download_values;
        std::vector<double> upload_values;
        download_values.reserve(samples.size());
        upload_values.reserve(samples.size());

        double max_rate = 1.0;
        for (const auto& sample : samples) {
            download_values.push_back(sample.download_bytes_per_second);
            upload_values.push_back(sample.upload_bytes_per_second);
            max_rate = std::max(max_rate, std::max(sample.download_bytes_per_second, sample.upload_bytes_per_second));
        }

        draw_line(download_values, max_rate, 0.23, 0.72, 0.98);
        draw_line(upload_values, max_rate, 0.25, 0.85, 0.42);
    }

    static gboolean sync_summary_on_main(gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->apply_summary();
        return G_SOURCE_REMOVE;
    }

    static gboolean sync_metrics_on_main(gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->apply_metrics();
        return G_SOURCE_REMOVE;
    }

    static gboolean sync_alerts_on_main(gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->apply_alerts();
        return G_SOURCE_REMOVE;
    }

    static gboolean quit_on_main(gpointer) {
        gtk_main_quit();
        return G_SOURCE_REMOVE;
    }

    static gboolean on_unix_signal(gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->request_quit();
        return G_SOURCE_REMOVE;
    }

    static void on_open_monitor(GtkMenuItem*, gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->present_window(0);
    }

    static void on_open_settings(GtkMenuItem*, gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->present_window(
            static_cast<LinuxTrayAdapter*>(user_data)->settings_page_index_);
    }

    static void on_quit(GtkWidget*, gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->request_quit();
    }

    static gboolean on_delete_event(GtkWidget* widget, GdkEvent*, gpointer) {
        gtk_widget_hide(widget);
        return TRUE;
    }

    static void on_toggle_notifications(GtkCheckMenuItem* item, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        if (self->suppress_signal_updates_) {
            return;
        }

        auto settings = self->settings_snapshot();
        settings.notifications_enabled = gtk_check_menu_item_get_active(item);
        if (!settings.notifications_enabled) {
            settings.notification_snooze_until_epoch_seconds.reset();
        }
        self->apply_settings(std::move(settings), false, "Notification preference updated.");
    }

    static void on_toggle_autostart(GtkCheckMenuItem* item, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        if (self->suppress_signal_updates_) {
            return;
        }

        auto settings = self->settings_snapshot();
        settings.autostart_enabled = gtk_check_menu_item_get_active(item);
        self->apply_settings(std::move(settings), false, "Launch-at-login preference updated.");
    }

    static void on_apply_settings(GtkButton*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = self->collect_settings_from_widgets();
        self->apply_settings(std::move(settings), true, "Settings applied and saved.");
    }

    static void on_settings_widget_changed(GtkWidget*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        if (self->suppress_signal_updates_) {
            return;
        }
        self->update_settings_dirty_state();
    }

    static void on_reload_saved(GtkButton*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = load_settings(self->config_path_);
        self->populate_settings_form(settings);
        self->set_status_message("Reloaded saved settings into the form. Click Apply to use them.");
    }

    static void on_load_defaults(GtkButton*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = default_settings();
        settings.autostart_enabled = self->settings_snapshot().autostart_enabled;
        self->populate_settings_form(settings);
        self->set_status_message("Loaded default values into the form. Click Apply to save.");
    }

    static void on_clear_alerts(GtkButton*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        {
            std::scoped_lock lock(self->mutex_);
            self->alert_lines_.clear();
        }
        self->apply_alerts();
        self->set_status_message("Cleared alert history from the current session.");
    }

    static void on_snooze_30m(GtkMenuItem*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = self->settings_snapshot();
        settings.notifications_enabled = true;
        settings.notification_snooze_until_epoch_seconds =
            std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::system_clock::now().time_since_epoch() + std::chrono::minutes(30))
                .count();
        self->apply_settings(std::move(settings), false, "Desktop notifications snoozed for 30 minutes.");
    }

    static void on_snooze_2h(GtkMenuItem*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = self->settings_snapshot();
        settings.notifications_enabled = true;
        settings.notification_snooze_until_epoch_seconds =
            std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::system_clock::now().time_since_epoch() + std::chrono::hours(2))
                .count();
        self->apply_settings(std::move(settings), false, "Desktop notifications snoozed for 2 hours.");
    }

    static void on_resume_notifications(GtkMenuItem*, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        auto settings = self->settings_snapshot();
        settings.notifications_enabled = true;
        settings.notification_snooze_until_epoch_seconds.reset();
        self->apply_settings(std::move(settings), false, "Desktop notifications resumed.");
    }

    static void on_toggle_rule_notification_snooze(GtkButton* button, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        const int index = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(button), "rule-index"));
        auto settings = self->settings_snapshot();
        if (index < 0 || static_cast<std::size_t>(index) >= settings.alert_rules.size()) {
            return;
        }

        auto& rule = settings.alert_rules[static_cast<std::size_t>(index)];
        const auto rule_id = rule.id;
        const auto now_seconds = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        if (rule.notification_snooze_until_epoch_seconds.has_value() &&
            *rule.notification_snooze_until_epoch_seconds > now_seconds) {
            rule.notification_snooze_until_epoch_seconds.reset();
            self->apply_settings(
                std::move(settings),
                false,
                "Rule '" + rule_id + "' notifications resumed.");
            return;
        }

        rule.notification_snooze_until_epoch_seconds = now_seconds + std::chrono::minutes(30).count();
        self->apply_settings(
            std::move(settings),
            false,
            "Rule '" + rule_id + "' notifications snoozed for 30 minutes.");
    }

    static void on_reset_rule(GtkButton* button, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        const int index = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(button), "rule-index"));
        if (index < 0 || static_cast<std::size_t>(index) >= self->rule_editors_.size()) {
            return;
        }

        const auto& editor = self->rule_editors_[static_cast<std::size_t>(index)];
        const auto default_rule = default_alert_rule(editor.rule_id);
        if (!default_rule.has_value()) {
            self->set_status_message("No default rule found for " + editor.rule_id + ".");
            return;
        }

        self->suppress_signal_updates_ = true;
        self->populate_rule_form(editor, *default_rule);
        self->suppress_signal_updates_ = false;
        self->update_settings_dirty_state();
        self->set_status_message("Reset rule '" + editor.rule_id + "' to its default values in the form.");
    }

    static gboolean on_draw_chart(GtkWidget* widget, cairo_t* cr, gpointer user_data) {
        static_cast<LinuxTrayAdapter*>(user_data)->draw_chart(widget, cr);
        return FALSE;
    }

    mutable std::mutex mutex_;
    Settings settings_;
    std::filesystem::path config_path_;
    IAutostartAdapter* autostart_adapter_ = nullptr;
    std::string executable_path_;
    SettingsListener settings_listener_;

    TraySummary summary_ {};
    std::optional<MetricDelta> latest_;
    HistorySnapshot history_ {};
    std::deque<std::string> alert_lines_ {};
    std::optional<TimePoint> last_summary_update_ {};

    AppIndicator* indicator_ = nullptr;
    GtkWidget* menu_ = nullptr;
    GtkWidget* summary_menu_item_ = nullptr;
    GtkWidget* cpu_menu_item_ = nullptr;
    GtkWidget* network_menu_item_ = nullptr;
    GtkWidget* notification_status_item_ = nullptr;
    GtkWidget* open_item_ = nullptr;
    GtkWidget* settings_item_ = nullptr;
    GtkWidget* notifications_item_ = nullptr;
    GtkWidget* snooze_30m_item_ = nullptr;
    GtkWidget* snooze_2h_item_ = nullptr;
    GtkWidget* resume_notifications_item_ = nullptr;
    GtkWidget* autostart_item_ = nullptr;
    GtkWidget* quit_item_ = nullptr;

    GtkWidget* window_ = nullptr;
    GtkWidget* notebook_ = nullptr;
    int settings_page_index_ = 0;
    GtkWidget* summary_label_ = nullptr;
    GtkWidget* updated_at_label_ = nullptr;
    GtkWidget* cpu_value_label_ = nullptr;
    GtkWidget* memory_value_label_ = nullptr;
    GtkWidget* download_value_label_ = nullptr;
    GtkWidget* upload_value_label_ = nullptr;
    GtkWidget* network_value_label_ = nullptr;
    GtkWidget* cpu_chart_ = nullptr;
    GtkWidget* memory_chart_ = nullptr;
    GtkWidget* network_chart_ = nullptr;
    GtkListStore* interface_store_ = nullptr;
    GtkTextBuffer* alerts_buffer_ = nullptr;
    GtkWidget* clear_alerts_button_ = nullptr;
    GtkWidget* alerts_hint_label_ = nullptr;

    GtkWidget* sample_interval_spin_ = nullptr;
    GtkWidget* tray_refresh_spin_ = nullptr;
    GtkWidget* settings_notifications_check_ = nullptr;
    GtkWidget* settings_autostart_check_ = nullptr;
    GtkWidget* quiet_hours_check_ = nullptr;
    GtkWidget* quiet_hours_start_hour_spin_ = nullptr;
    GtkWidget* quiet_hours_start_minute_spin_ = nullptr;
    GtkWidget* quiet_hours_end_hour_spin_ = nullptr;
    GtkWidget* quiet_hours_end_minute_spin_ = nullptr;
    GtkWidget* notification_runtime_label_ = nullptr;
    GtkWidget* apply_settings_button_ = nullptr;
    GtkWidget* settings_status_label_ = nullptr;
    GtkWidget* settings_dirty_label_ = nullptr;
    std::vector<RuleEditorWidgets> rule_editors_ {};

    bool suppress_signal_updates_ = false;
    bool initialized_ = false;
};

}  // namespace

PlatformComponents create_platform_components(const Settings& settings) {
    PlatformComponents components;
    components.metrics_provider = create_linux_metrics_provider();
    components.autostart_adapter = std::make_unique<LinuxAutostartAdapter>();
    components.tray_adapter = std::make_unique<LinuxTrayAdapter>(
        settings,
        default_config_path(),
        components.autostart_adapter.get());
    components.notification_adapter = std::make_unique<LinuxNotificationAdapter>();
    return components;
}

Application::Application(Settings settings) : settings_(std::move(settings)) {}

int Application::run() {
    auto components = create_platform_components(settings_);
    auto* tray = dynamic_cast<LinuxTrayAdapter*>(components.tray_adapter.get());
    if (tray == nullptr) {
        throw std::runtime_error("Linux tray adapter is unavailable");
    }

    components.tray_adapter->initialize();

    MonitorService monitor(std::move(components.metrics_provider), settings_);
    tray->set_settings_listener([&monitor](const Settings& settings) {
        monitor.update_settings(settings);
    });

    monitor.set_metric_listener([tray](const MetricDelta& delta, const HistorySnapshot& history) {
        tray->consume_metric_update(delta, history);
    });

    monitor.set_alert_listener([tray, notification = components.notification_adapter.get()](const AlertEvent& event) {
        tray->append_alert(event);
        if (tray->notifications_enabled_for_rule(event.rule_id)) {
            notification->notify(event);
        }
    });

    monitor.start();
    const int exit_code = tray->run_loop();
    monitor.stop();
    components.tray_adapter->shutdown();
    return exit_code;
}

}  // namespace network_watch
