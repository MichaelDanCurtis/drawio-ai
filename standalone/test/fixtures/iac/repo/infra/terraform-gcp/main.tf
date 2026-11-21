resource "google_compute_network" "vpc" {
  name                    = "app-net"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "app" {
  name          = "app"
  ip_cidr_range = "10.10.0.0/24"
  network       = google_compute_network.vpc.id
  region        = "europe-west1"
}

resource "google_compute_firewall" "ssh" {
  name          = "allow-ssh"
  network       = google_compute_network.vpc.name
  source_ranges = ["0.0.0.0/0"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_instance" "app" {
  name         = "app-1"
  machine_type = "e2-medium"
  zone         = "europe-west1-b"
  network_interface {
    subnetwork = google_compute_subnetwork.app.self_link
  }
}

resource "google_storage_bucket" "data" {
  name     = "example-data"
  location = "EU"
}

resource "google_sql_database_instance" "db" {
  name             = "app-db"
  database_version = "POSTGRES_15"
  deletion_protection = false
  settings {
    tier = "db-f1-micro"
    ip_configuration {
      private_network = google_compute_network.vpc.id
    }
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "api"
  location = "europe-west1"
  template {
    containers {
      image = "gcr.io/example/api"
      env {
        name  = "BUCKET"
        value = google_storage_bucket.data.name
      }
    }
  }
}
