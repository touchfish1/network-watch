#include "network_watch/application.hpp"

#include <gtk/gtk.h>
#include <glib-unix.h>
#include <libayatana-appindicator/app-indicator.h>
#include <libnotify/notify.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
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

        create_window();
        create_menu();
        create_indicator();

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
        std::scoped_lock lock(mutex_);
        return settings_.notifications_enabled;
    }

private:
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

        open_item_ = gtk_menu_item_new_with_label("Open Monitor");
        g_signal_connect(open_item_, "activate", G_CALLBACK(&LinuxTrayAdapter::on_open_monitor), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), open_item_);

        notifications_item_ = gtk_check_menu_item_new_with_label("Enable Notifications");
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(notifications_item_), settings_.notifications_enabled);
        g_signal_connect(notifications_item_, "toggled", G_CALLBACK(&LinuxTrayAdapter::on_toggle_notifications), this);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu_), notifications_item_);

        autostart_item_ = gtk_check_menu_item_new_with_label("Launch at Login");
        const bool autostart_active = autostart_adapter_ != nullptr && autostart_adapter_->is_enabled();
        settings_.autostart_enabled = autostart_active;
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(autostart_item_), autostart_active);
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
        gtk_window_set_default_size(GTK_WINDOW(window_), 920, 680);
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

        GtkWidget* notebook = gtk_notebook_new();
        gtk_widget_set_vexpand(notebook, TRUE);
        gtk_box_pack_start(GTK_BOX(outer_box), notebook, TRUE, TRUE, 0);

        GtkWidget* trends_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 10);
        cpu_chart_ = gtk_drawing_area_new();
        memory_chart_ = gtk_drawing_area_new();
        network_chart_ = gtk_drawing_area_new();

        create_chart_area(cpu_chart_, "CPU Trend", ChartKind::Cpu, trends_box);
        create_chart_area(memory_chart_, "Memory Trend", ChartKind::Memory, trends_box);
        create_chart_area(network_chart_, "Network Throughput", ChartKind::Network, trends_box);
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook), trends_box, gtk_label_new("Trends"));

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
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook), interfaces_box, gtk_label_new("Interfaces"));

        GtkWidget* alerts_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 8);
        GtkWidget* alert_text = gtk_text_view_new();
        gtk_text_view_set_editable(GTK_TEXT_VIEW(alert_text), FALSE);
        gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(alert_text), FALSE);
        alerts_buffer_ = gtk_text_view_get_buffer(GTK_TEXT_VIEW(alert_text));

        GtkWidget* alert_scroll = gtk_scrolled_window_new(nullptr, nullptr);
        gtk_widget_set_vexpand(alert_scroll, TRUE);
        gtk_container_add(GTK_CONTAINER(alert_scroll), alert_text);
        gtk_box_pack_start(GTK_BOX(alerts_box), alert_scroll, TRUE, TRUE, 0);
        gtk_notebook_append_page(GTK_NOTEBOOK(notebook), alerts_box, gtk_label_new("Alerts"));

        GtkWidget* footer_box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 8);
        gtk_box_pack_end(GTK_BOX(outer_box), footer_box, FALSE, FALSE, 0);

        GtkWidget* hide_button = gtk_button_new_with_label("Hide");
        g_signal_connect_swapped(hide_button, "clicked", G_CALLBACK(gtk_widget_hide), window_);
        gtk_box_pack_end(GTK_BOX(footer_box), hide_button, FALSE, FALSE, 0);

        GtkWidget* quit_button = gtk_button_new_with_label("Quit");
        g_signal_connect(quit_button, "clicked", G_CALLBACK(&LinuxTrayAdapter::on_quit), this);
        gtk_box_pack_end(GTK_BOX(footer_box), quit_button, FALSE, FALSE, 0);
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

    void present_window() {
        gtk_widget_show_all(window_);
        gtk_window_present(GTK_WINDOW(window_));
    }

    void persist_settings() {
        save_settings(config_path_, settings_);
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
        gtk_label_set_text(
            GTK_LABEL(network_value_label_),
            latest->network_connected ? "Connected" : "Offline");
        gtk_label_set_text(
            GTK_LABEL(updated_at_label_),
            ("Last updated: " + format_timestamp(latest->timestamp)).c_str());

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

        {
            std::scoped_lock lock(mutex_);
            history_ = std::move(history);
        }
    }

    void apply_alerts() {
        std::deque<std::string> lines;
        {
            std::scoped_lock lock(mutex_);
            lines = alert_lines_;
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

        std::optional<MetricDelta> latest;
        HistorySnapshot history;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
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
                const double x = values.size() == 1 ? width / 2.0 : (static_cast<double>(index) / (values.size() - 1)) * (width - 16.0) + 8.0;
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
        static_cast<LinuxTrayAdapter*>(user_data)->present_window();
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
        const bool enabled = gtk_check_menu_item_get_active(item);

        {
            std::scoped_lock lock(self->mutex_);
            if (self->settings_.notifications_enabled == enabled) {
                return;
            }
            self->settings_.notifications_enabled = enabled;
        }

        self->persist_settings();
    }

    static void on_toggle_autostart(GtkCheckMenuItem* item, gpointer user_data) {
        auto* self = static_cast<LinuxTrayAdapter*>(user_data);
        const bool enabled = gtk_check_menu_item_get_active(item);

        bool current_enabled = false;
        {
            std::scoped_lock lock(self->mutex_);
            current_enabled = self->settings_.autostart_enabled;
        }

        if (current_enabled == enabled) {
            return;
        }

        bool success = false;
        if (self->autostart_adapter_ != nullptr) {
            success = enabled ? self->autostart_adapter_->enable(self->executable_path_) : self->autostart_adapter_->disable();
        }

        if (!success) {
            g_signal_handlers_block_by_func(item, reinterpret_cast<gpointer>(&LinuxTrayAdapter::on_toggle_autostart), user_data);
            gtk_check_menu_item_set_active(item, current_enabled);
            g_signal_handlers_unblock_by_func(item, reinterpret_cast<gpointer>(&LinuxTrayAdapter::on_toggle_autostart), user_data);
            return;
        }

        {
            std::scoped_lock lock(self->mutex_);
            self->settings_.autostart_enabled = enabled;
        }
        self->persist_settings();
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

    TraySummary summary_ {};
    std::optional<MetricDelta> latest_;
    HistorySnapshot history_ {};
    std::deque<std::string> alert_lines_ {};

    AppIndicator* indicator_ = nullptr;
    GtkWidget* menu_ = nullptr;
    GtkWidget* open_item_ = nullptr;
    GtkWidget* notifications_item_ = nullptr;
    GtkWidget* autostart_item_ = nullptr;
    GtkWidget* quit_item_ = nullptr;

    GtkWidget* window_ = nullptr;
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

    if (settings_.autostart_enabled && components.autostart_adapter != nullptr && !components.autostart_adapter->is_enabled()) {
        components.autostart_adapter->enable(current_executable_path());
    }

    MonitorService monitor(std::move(components.metrics_provider), settings_);

    monitor.set_metric_listener(
        [tray, tray_interval = settings_.tray_refresh_interval, last_tray_update = std::optional<TimePoint> {}](
            const MetricDelta& delta,
            const HistorySnapshot& history) mutable {
            tray->show_window(delta, history);

            if (!last_tray_update.has_value() || (delta.timestamp - *last_tray_update) >= tray_interval) {
                tray->update(build_tray_summary(delta));
                last_tray_update = delta.timestamp;
            }
        });

    monitor.set_alert_listener([tray, notification = components.notification_adapter.get()](const AlertEvent& event) {
        tray->append_alert(event);
        if (tray->notifications_enabled()) {
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
