import { Tag } from "antd";
import React from "react";

const statusColors = {
	unknown: "#d46b08",
	unassigned: "#d4380d",
	stopped: "#cf1322",
	starting: "#d4b106",
	running: "#52c41a",
	stopping: "#d48806",
	creating_save: "#096dd9",
	exporting_data: "#08979c",
	deleted: "#cf1322",
};


export default function InstanceStatusTag(props) {
	return <Tag color={statusColors[props.status]}>
		{props.status}
	</Tag>;
}
