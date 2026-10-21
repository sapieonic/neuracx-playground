variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "ap-south-1"
}

variable "name" {
  description = "Name prefix for all resources."
  type        = string
  default     = "neuracx-voicebot"
}

variable "domain" {
  description = "Domain that will point at the static IP, e.g. voicebot.example.com. Caddy gets the TLS cert for it."
  type        = string
}

variable "acme_email" {
  description = "Email for Let's Encrypt expiry notices."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type. Graviton types (t4g.*) work too."
  type        = string
  default     = "t3.small"
}

variable "ssh_public_key_path" {
  description = "Public key allowed to SSH in as ec2-user (used by deploy.sh)."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "ssh_cidr" {
  description = "Who may SSH in. Set this to your own IP as x.x.x.x/32 (curl -s https://checkip.amazonaws.com). The default opens port 22 to the whole internet (key-only login)."
  type        = string
  default     = "0.0.0.0/0"

  validation {
    condition     = can(cidrhost(var.ssh_cidr, 0))
    error_message = "ssh_cidr must be a CIDR block such as 203.0.113.10/32."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the VPC created for this server."
  type        = string
  default     = "10.40.0.0/16"
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone ID. If set, an A record for var.domain is created. Leave empty if your DNS is elsewhere."
  type        = string
  default     = ""
}
